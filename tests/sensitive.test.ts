import { describe, expect, it } from "vitest"
import { collectEnvSecrets, SensitiveChecker } from "../src/sensitive"

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
