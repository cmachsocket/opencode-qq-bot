import { describe, expect, it, vi } from "vitest"
import { mkdtemp, writeFile, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  allowedTools,
  defaultToolPolicy,
  globMatch,
  parseToolPolicy,
  profileNameFor,
  ToolPolicy,
} from "../src/tools/policy"
import type { Logger } from "../src/logger"

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe("globMatch", () => {
  it("matches the whole name only", () => {
    expect(globMatch("qq_*", "qq_send_message")).toBe(true)
    expect(globMatch("qq_*", "xqq_send_message")).toBe(false)
    expect(globMatch("*", "anything")).toBe(true)
    expect(globMatch("read", "read_file")).toBe(false)
  })

  it("supports question marks and treats dots literally", () => {
    expect(globMatch("read?", "read1")).toBe(true)
    expect(globMatch("a.b", "axb")).toBe(false)
  })
})

describe("parseToolPolicy", () => {
  it("falls back to the built-in policy for garbage", () => {
    const warn = vi.fn()
    expect(parseToolPolicy("nope", warn)).toEqual(defaultToolPolicy())
    expect(warn).toHaveBeenCalled()
  })

  it("keeps built-in profiles next to user ones", () => {
    const warn = vi.fn()
    const file = parseToolPolicy(
      { profiles: { quiet: { allow: ["read"], deny: [] } }, defaultProfile: "quiet" },
      warn,
    )
    expect(file.defaultProfile).toBe("quiet")
    expect(file.profiles.quiet).toEqual({ allow: ["read"], deny: [] })
    expect(file.profiles.chat).toEqual(defaultToolPolicy().profiles.chat)
    expect(warn).not.toHaveBeenCalled()
  })

  it("rejects a default profile that does not exist", () => {
    const warn = vi.fn()
    const file = parseToolPolicy({ defaultProfile: "missing" }, warn)
    expect(file.defaultProfile).toBe("chat")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("defaultProfile"))
  })

  it("drops non-string entries from allow and deny", () => {
    const warn = vi.fn()
    const file = parseToolPolicy(
      { profiles: { chat: { allow: ["read", 3, ""], deny: "nope" } } },
      warn,
    )
    expect(file.profiles.chat?.allow).toEqual(["read"])
    expect(file.profiles.chat?.deny).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it("ignores profile names taken from the prototype", () => {
    const warn = vi.fn()
    // JSON.parse 会把 __proto__ 变成自有属性，正好复现「配置档名是原型属性名」这条路。
    const raw = JSON.parse(
      '{"profiles":{"__proto__":{"allow":["read"],"deny":[]},"constructor":{"allow":["read"]}}}',
    )
    const file = parseToolPolicy(raw, warn)
    expect(Object.hasOwn(file.profiles, "__proto__")).toBe(false)
    expect(Object.hasOwn(file.profiles, "constructor")).toBe(false)
    expect(warn).toHaveBeenCalled()
    // 名字取不到时退回默认档，而不是取到 Object.prototype 上的东西。
    expect(profileNameFor(file, "member", "group:1")).toBe("chat")
  })
})

describe("defaultToolPolicy", () => {
  it("keeps only web search, web fetch and qq tools for members", () => {
    const chat = defaultToolPolicy().profiles.chat
    expect(chat).toBeDefined()
    const names = [
      "websearch",
      "webfetch",
      "qq_send_message",
      "shell",
      "write",
      "edit",
      "read",
      "subagent",
      "task",
    ]
    expect(allowedTools(chat!, names).sort()).toEqual(["qq_send_message", "webfetch", "websearch"])
  })

  it("gives proactive turns the same low privilege as members", () => {
    const proactive = defaultToolPolicy().profiles.proactive
    expect(proactive).toBeDefined()
    expect(allowedTools(proactive!, ["shell", "write", "qq_send_message"]).sort()).toEqual([
      "qq_send_message",
    ])
  })

  it("keeps diary tools away from members and proactive turns", () => {
    const names = [
      "qq_diary_write",
      "qq_diary_read",
      "qq_diary_list",
      "qq_send_file",
      "qq_send_message",
    ]
    const file = defaultToolPolicy()
    for (const profile of ["chat", "readonly", "proactive"] as const) {
      const allowed = allowedTools(file.profiles[profile]!, names)
      expect(allowed, `${profile} 档不该拿到日记与文件工具`).toEqual(["qq_send_message"])
    }
  })

  it("lets owner and admin use the diary tools", () => {
    const admin = defaultToolPolicy().profiles.admin
    expect(admin).toBeDefined()
    expect(
      allowedTools(admin!, [
        "qq_diary_write",
        "qq_diary_read",
        "qq_diary_list",
        "qq_send_file",
      ]).sort(),
    ).toEqual(["qq_diary_list", "qq_diary_read", "qq_diary_write", "qq_send_file"])
  })
})

describe("profileNameFor", () => {
  const file = parseToolPolicy(
    {
      defaultProfile: "chat",
      profiles: { chat: { allow: ["*"], deny: [] } },
      chats: { "group:100": "readonly", "private:200": "admin" },
    },
    () => {},
  )

  it("gives owner and admin the admin profile", () => {
    expect(profileNameFor(file, "owner", "group:999")).toBe("admin")
    expect(profileNameFor(file, "admin", "group:999")).toBe("admin")
  })

  it("uses the per-chat profile for members", () => {
    expect(profileNameFor(file, "member", "group:100")).toBe("readonly")
    expect(profileNameFor(file, "member", "group:999")).toBe("chat")
  })

  it("never gives proactive turns the admin or per-chat profile", () => {
    // 内置默认值里有 proactive 档：主动说话固定用它，而不是 chats 里映射的 readonly。
    expect(profileNameFor(file, "proactive", "group:100")).toBe("proactive")
    expect(profileNameFor(file, "proactive", "private:200")).toBe("proactive")
    const withProactive = parseToolPolicy(
      {
        profiles: {
          chat: { allow: ["*"], deny: [] },
          proactive: { allow: ["qq_*"], deny: [] },
        },
      },
      () => {},
    )
    expect(profileNameFor(withProactive, "proactive", "group:100")).toBe("proactive")
  })

  it("falls back when the chat points at an unknown profile", () => {
    const broken = parseToolPolicy({ chats: { "group:1": "nope" } }, () => {})
    expect(profileNameFor(broken, "member", "group:1")).toBe("chat")
  })
})

describe("allowedTools", () => {
  it("lets deny win over allow", () => {
    const profile = { allow: ["*"], deny: ["webfetch", "qq_send_*"] }
    expect(allowedTools(profile, ["bash", "webfetch", "qq_send_message", "read"])).toEqual([
      "bash",
      "read",
    ])
  })

  it("supports prefix wildcards", () => {
    const profile = { allow: ["qq_*"], deny: [] }
    expect(allowedTools(profile, ["qq_send_message", "bash"])).toEqual(["qq_send_message"])
  })
})

describe("ToolPolicy", () => {
  it("loads a file and switches profiles by chat", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qq-policy-"))
    const path = join(dir, "tool-profiles.json")
    await writeFile(
      path,
      JSON.stringify({ chats: { "group:100": "readonly" }, profiles: {} }),
      "utf8",
    )
    const policy = new ToolPolicy(path, logger)
    const names = ["read", "bash", "qq_send_message"]
    expect([...(await policy.allow("member", "group:100", names))].sort()).toEqual([
      "qq_send_message",
      "read",
    ])
    expect((await policy.allow("owner", "group:100", names)).size).toBe(3)
    expect(await policy.profileOf("member", "group:100")).toBe("readonly")
  })

  it("keeps owner-only diary tools away from admins", async () => {
    const policy = new ToolPolicy(join(tmpdir(), "qq-policy-missing", "none.json"), logger)
    const names = ["qq_diary_write", "qq_diary_read", "qq_diary_list", "qq_send_message"]
    // admin 档位本身允许日记工具，但角色不是 owner，运行时必须再收一次。
    expect([...(await policy.allow("admin", "private:200", names))].sort()).toEqual([
      "qq_send_message",
    ])
    expect([...(await policy.allow("owner", "private:200", names))].sort()).toEqual(
      [...names].sort(),
    )
  })

  it("misses a file by using the built-in policy", async () => {
    const policy = new ToolPolicy(join(tmpdir(), "qq-policy-missing", "none.json"), logger)
    expect(await policy.current()).toEqual(defaultToolPolicy())
  })

  it("keeps the previous policy when the new file is half written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qq-policy-"))
    const path = join(dir, "tool-profiles.json")
    await writeFile(path, JSON.stringify({ defaultProfile: "readonly" }), "utf8")
    const policy = new ToolPolicy(path, logger)
    expect((await policy.current()).defaultProfile).toBe("readonly")

    await writeFile(path, "{ broken", "utf8")
    // mtime 精度不足时手动推后，确保触发重新读取。
    const later = new Date(Date.now() + 5_000)
    await utimes(path, later, later)

    expect((await policy.current()).defaultProfile).toBe("readonly")
  })

  it("reloads after the file changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qq-policy-"))
    const path = join(dir, "tool-profiles.json")
    await writeFile(path, JSON.stringify({ defaultProfile: "chat" }), "utf8")
    const policy = new ToolPolicy(path, logger)
    expect((await policy.current()).defaultProfile).toBe("chat")

    await writeFile(path, JSON.stringify({ defaultProfile: "readonly" }), "utf8")
    const later = new Date(Date.now() + 5_000)
    await utimes(path, later, later)

    expect((await policy.current()).defaultProfile).toBe("readonly")
  })
})
