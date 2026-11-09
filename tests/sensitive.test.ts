import { describe, expect, it } from "vitest"
import {
  collectEnvSecrets,
  maskSecrets,
  redactUrl,
  secretsFromUrl,
  SensitiveChecker,
} from "../src/sensitive"

const known = "sk-super-secret-token-value-1234567890"

function check(text: string, knownSecrets: string[] = []): boolean {
  return new SensitiveChecker({ knownSecrets }).check(text).allowed
}

describe("SensitiveChecker", () => {
  it("passes ordinary chat", () => {
    expect(check("大家好，今天天气不错")).toBe(true)
    expect(check("我的QQ号是123456789，手机号13800138000")).toBe(true)
    expect(check("我的邮箱是 foo@example.com")).toBe(true)
    expect(check("参考 https://example.com/a/b?c=d 这个链接")).toBe(true)
    expect(check("订单号 6ba7b810-9dad-11d1-80b4-00c04fd430c8 已发货")).toBe(true)
  })

  it("blocks API keys", () => {
    expect(check("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe(false)
    expect(check("sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(false)
    expect(check("AKIAIOSFODNN7EXAMPLE")).toBe(false)
  })

  it("blocks credential assignments", () => {
    expect(check('password = "hunter2000"')).toBe(false)
    expect(check("密码：hunter2000")).toBe(false)
  })

  it("blocks assignments written with full-width characters", () => {
    expect(check("ｐａｓｓｗｏｒｄ＝ｈｕｎｔｅｒ２０００")).toBe(false)
  })

  it("blocks assignments broken up with zero-width characters", () => {
    expect(check("pass\u200bword = hunter2000")).toBe(false)
  })

  it("blocks known secrets, including split and fragmented forms", () => {
    expect(check(`这是 ${known} 谢谢`, [known])).toBe(false)
    expect(check("这是 sk-super-secret-token-value-1234-567890 谢谢", [known])).toBe(false)
    expect(check("这是 sk-super-secret-token-value-1234 567890 谢谢", [known])).toBe(false)
  })

  it("blocks base64-encoded credentials", () => {
    const encoded = Buffer.from("sk-ant-api03-" + "x".repeat(48)).toString("base64")
    expect(check(`这是 ${encoded} 谢谢`)).toBe(false)
  })

  it("blocks paths that point at credential files", () => {
    expect(check("文件在 /home/user/.ssh/id_rsa 那里")).toBe(false)
    expect(check("读取 ~/.aws/credentials 看看")).toBe(false)
    expect(check("备份在 ~/.pgpass 里")).toBe(false)
    expect(check("证书是 server.id_ecdsa")).toBe(false)
  })

  it("blocks internal URLs", () => {
    expect(check("接口在 http://localhost:3000/api 上")).toBe(false)
    expect(check("去 http://192.168.1.10:8080/admin 看看")).toBe(false)
  })

  it("reports the detectors that matched", () => {
    const verdict = new SensitiveChecker().check("ghp_abcdefghijklmnopqrstuvwxyz0123456789")
    expect(verdict.allowed).toBe(false)
    expect(verdict.hits.map((hit) => hit.detector)).toContain("github_token")
    expect(verdict.reason).toContain("github_token")
  })

  it("does nothing when disabled", () => {
    const checker = new SensitiveChecker({ enabled: false })
    expect(checker.check("ghp_abcdefghijklmnopqrstuvwxyz0123456789").allowed).toBe(true)
  })
})

describe("maskSecrets", () => {
  it("归一化后命中的混淆凭证整行丢弃", () => {
    expect(maskSecrets("key=ＡＫＩＡＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰ")).toBe("[REDACTED]")
    expect(maskSecrets("key=ghp_abcd\u200Befghijklmnopqrstuvwxyz0123456789")).toBe("[REDACTED]")
  })

  it("普通文本保持原样", () => {
    expect(maskSecrets("大家好，今天天气不错")).toBe("大家好，今天天气不错")
  })
})

describe("collectEnvSecrets", () => {
  it("keeps values whose names look like credentials", () => {
    expect(
      collectEnvSecrets({
        ANTHROPIC_API_KEY: "sk-ant-abcdefghijklmnop",
        NAPCAT_WS_TOKEN: "abcdefghijklmnop",
        QQ_BOT_SOUL_PATH: "/home/user/souls",
        PATH: "/usr/bin:/bin",
        LOG_LEVEL: "debug",
      }),
    ).toEqual(["sk-ant-abcdefghijklmnop", "abcdefghijklmnop"])
  })

  it("skips short values, URLs, paths and JSON", () => {
    expect(
      collectEnvSecrets({
        API_KEY: "short",
        TOKEN_URL: "https://example.com/abcdefghijklmnop",
        SECRET_PATH: "/home/user/abcdefghijklmnop",
        AUTH_JSON: '{"token":"abcdefghijklmnop"}',
      }),
    ).toEqual([])
  })
})

describe("redactUrl", () => {
  it("drops query, fragment and userinfo", () => {
    expect(redactUrl("ws://127.0.0.1:3000/?access_token=abcdefghijklmnop#x")).toBe(
      "ws://127.0.0.1:3000/",
    )
    expect(redactUrl("http://user:abcdefghijklmnop@example.com:8080/path?token=x")).toBe(
      "http://example.com:8080/path",
    )
  })

  it("keeps the address when there is nothing to redact", () => {
    expect(redactUrl("ws://127.0.0.1:3000/ws")).toBe("ws://127.0.0.1:3000/ws")
  })

  it("replaces unparseable addresses", () => {
    expect(redactUrl("not a url")).toBe("[无法解析的地址]")
  })
})

describe("secretsFromUrl", () => {
  it("collects long credential-looking query values", () => {
    expect(
      secretsFromUrl("ws://host:3000/ws?access_token=abcdefghijklmnop&page=2&secret=123456789012"),
    ).toEqual(["abcdefghijklmnop", "123456789012"])
  })

  it("collects userinfo credentials", () => {
    expect(secretsFromUrl("http://abc1234567890:def1234567890@example.com/")).toEqual([
      "abc1234567890",
      "def1234567890",
    ])
  })

  it("ignores short values and unparseable addresses", () => {
    expect(secretsFromUrl("ws://host:3000/ws?token=short")).toEqual([])
    expect(secretsFromUrl("not a url")).toEqual([])
  })
})
