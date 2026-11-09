import { describe, expect, it, vi } from "vitest"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  COMMANDS,
  handleCommand,
  isCommandChat,
  parseChatArg,
  parseCommand,
  splitArgs,
} from "../src/commands"
import { DEFAULT_CONFIG, type QQBotConfig } from "../src/config"
import type { Logger } from "../src/logger"
import type { ChatTarget } from "../src/chat"
import type { SessionManager } from "../src/session/manager"
import { roleOf, ToolPolicy } from "../src/tools/policy"
import { registerTuiCommands, tuiCommandName } from "../src/tui-commands"
import type { Plugin } from "@opencode/plugin"
import type { SendRateLimiter } from "../src/rate-limit"
import { accessConfig } from "./fixtures"
import { ChatOverrides } from "../src/overrides"

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const config: QQBotConfig = {
  ...DEFAULT_CONFIG,
  napcat: { url: "ws://127.0.0.1:3001" },
  access: accessConfig({ groups: [100], users: [200] }),
  ownerQQ: 200,
  admins: [300],
}

interface Sent {
  target: ChatTarget
  text: string
}

function createDeps() {
  const sent: Sent[] = []
  const resetTarget = vi.fn(async () => ({ sessionID: "session-1", interrupted: true }))
  const manager = {
    snapshot: () => [
      {
        target: { kind: "group" as const, id: 100 },
        sessionID: "session-1",
        busy: false,
        buffered: 2,
        pending: false,
      },
    ],
    resetTarget,
  } as unknown as SessionManager
  const policy = new ToolPolicy(join(tmpdir(), "qq-policy-commands", "none.json"), logger)
  const overrides = new ChatOverrides(join(tmpdir(), "qq-overrides-commands", "none.json"), logger)
  return {
    sent,
    resetTarget,
    overrides,
    deps: {
      config,
      manager,
      policy,
      overrides,
      target: { kind: "private" as const, id: 200 },
      send: async (target: ChatTarget, text: string) => {
        sent.push({ target, text })
      },
      toolNames: async () => [
        "read",
        "bash",
        "qq_send_message",
        "websearch",
        "webfetch",
        "task",
        "subagent",
      ],
    },
  }
}

describe("roleOf", () => {
  it("ranks owner above admin above member", () => {
    expect(roleOf(config, "200")).toBe("owner")
    expect(roleOf(config, "300")).toBe("admin")
    expect(roleOf(config, "400")).toBe("member")
  })

  it("treats everyone as a member without an owner", () => {
    expect(roleOf({ ...config, ownerQQ: undefined }, "200")).toBe("member")
  })
})

describe("isCommandChat", () => {
  const owner = { kind: "private" as const, id: 200 }

  it("accepts owner and admin private chats", () => {
    expect(isCommandChat(config, owner, "200")).toBe(true)
    expect(isCommandChat(config, { kind: "private", id: 300 }, "300")).toBe(true)
  })

  it("rejects groups, strangers and other people's chats", () => {
    expect(isCommandChat(config, { kind: "group", id: 200 }, "200")).toBe(false)
    expect(isCommandChat(config, { kind: "private", id: 400 }, "400")).toBe(false)
    // 别人冒用管理员的私聊号发消息：私聊 id 与发送者不一致。
    expect(isCommandChat(config, { kind: "private", id: 300 }, "200")).toBe(false)
    expect(isCommandChat({ ...config, ownerQQ: undefined, admins: [] }, owner, "200")).toBe(false)
  })
})

describe("parseCommand", () => {
  it("splits name and arguments", () => {
    expect(parseCommand("  /Reset group:100 ")).toEqual({
      name: "reset",
      args: ["group:100"],
    })
    expect(parseCommand("/help")).toEqual({ name: "help", args: [] })
  })

  it("ignores plain text and a lone slash", () => {
    expect(parseCommand("你好")).toBeUndefined()
    expect(parseCommand("/")).toBeUndefined()
  })
})

describe("splitArgs", () => {
  it("strips the command name in every accepted form", () => {
    expect(splitArgs("/reset group:100", "reset")).toEqual(["group:100"])
    expect(splitArgs("reset group:100", "reset")).toEqual(["group:100"])
    expect(splitArgs("group:100", "reset")).toEqual(["group:100"])
    expect(splitArgs("/reset", "reset")).toEqual([])
    expect(splitArgs("/qq-reset group:100", "qq-reset")).toEqual(["group:100"])
  })
})

describe("COMMANDS", () => {
  it("uses unique names and mentions each one in /help", () => {
    const names = COMMANDS.map((command) => command.name)
    expect(new Set(names).size).toBe(names.length)
    const help = COMMANDS.find((command) => command.name === "help")
    expect(help).toBeDefined()
    expect(help!.usage.join("\n")).toContain("/help")
    for (const name of names) {
      expect(COMMANDS.flatMap((command) => command.usage).join("\n")).toContain(`/${name}`)
    }
  })
})

describe("parseChatArg", () => {
  it("accepts keys and bare group numbers", () => {
    expect(parseChatArg("group:100")).toEqual({ kind: "group", id: 100 })
    expect(parseChatArg("private:200")).toEqual({ kind: "private", id: 200 })
    expect(parseChatArg("100")).toEqual({ kind: "group", id: 100 })
    expect(parseChatArg("nope")).toBeUndefined()
  })
})

describe("handleCommand", () => {
  it("answers /help and /status", async () => {
    const { deps, sent } = createDeps()
    expect(await handleCommand("/help", deps)).toBe(true)
    expect(sent[0]?.text).toContain("/reset")

    sent.length = 0
    expect(await handleCommand("/status", deps)).toBe(true)
    expect(sent[0]?.text).toContain("群 100")
    expect(sent[0]?.text).toContain("缓存 2 条")
  })

  it("shows the wake mode of every chat in /status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qq-overrides-status-"))
    const path = join(dir, "chat-overrides.json")
    await writeFile(path, JSON.stringify({ chats: { "group:100": { wake: "all" } } }), "utf8")
    const { deps, sent } = createDeps()
    deps.overrides = new ChatOverrides(path, logger)
    expect(await handleCommand("/status", deps)).toBe(true)
    expect(sent[0]?.text).toContain("唤醒 all")
    expect(sent[0]?.text).toContain("唤醒 mention（默认）")
  })

  it("lists every chat when /reset has no argument", async () => {
    const { deps, sent, resetTarget } = createDeps()
    expect(await handleCommand("/reset", deps)).toBe(true)
    expect(resetTarget).not.toHaveBeenCalled()
    expect(sent[0]?.text).toContain("/reset group:100")
    expect(sent[0]?.text).toContain("/reset private:200")
  })

  it("resets a named chat and rejects an unknown one", async () => {
    const { deps, sent, resetTarget } = createDeps()
    expect(await handleCommand("/reset group:100", deps)).toBe(true)
    expect(resetTarget).toHaveBeenCalledWith({ kind: "group", id: 100 })
    expect(sent[0]?.text).toContain("原回合已打断")

    sent.length = 0
    expect(await handleCommand("/reset nope", deps)).toBe(true)
    expect(sent[0]?.text).toContain("无法识别聊天")
  })

  it("refuses to reset a chat outside the allow list", async () => {
    const { deps, sent, resetTarget } = createDeps()
    expect(await handleCommand("/reset group:999", deps)).toBe(true)
    expect(resetTarget).not.toHaveBeenCalled()
    expect(sent[0]?.text).toContain("不在放行名单")
  })

  it("keeps chats outside the allow list out of the /reset list", async () => {
    const { deps, sent } = createDeps()
    deps.manager = {
      snapshot: () => [
        {
          target: { kind: "group" as const, id: 100 },
          sessionID: "session-1",
          busy: false,
          buffered: 0,
          pending: false,
        },
        {
          target: { kind: "group" as const, id: 999 },
          sessionID: "session-2",
          busy: false,
          buffered: 0,
          pending: false,
        },
      ],
      resetTarget: vi.fn(),
    } as unknown as SessionManager
    expect(await handleCommand("/reset", deps)).toBe(true)
    expect(sent[0]?.text).toContain("/reset group:100")
    expect(sent[0]?.text).not.toContain("group:999")
  })

  it("lists chat profiles and the tools of one chat", async () => {
    const { deps, sent } = createDeps()
    expect(await handleCommand("/tools", deps)).toBe(true)
    expect(sent[0]?.text).toContain("群 100：chat（3 个工具）")

    sent.length = 0
    expect(await handleCommand("/tools group:100", deps)).toBe(true)
    expect(sent[0]?.text).toContain("配置档 chat")
    expect(sent[0]?.text).toContain("qq_send_message")
    expect(sent[0]?.text).toContain("websearch")
    expect(sent[0]?.text).not.toContain("bash")
  })

  it("accepts the TUI prefix on the QQ side", async () => {
    const { deps, sent } = createDeps()
    expect(await handleCommand("/qq-help", deps)).toBe(true)
    expect(sent[0]?.text).toContain("/reset")
  })

  it("lists every command passed to the dispatcher", async () => {
    const { deps, sent } = createDeps()
    const extra = {
      name: "emoji-label",
      description: "给收藏表情生成标签",
      usage: ["/emoji-label list — 列出收藏表情"],
      run: async () => {},
    }
    await handleCommand("/help", deps, [...COMMANDS, extra])
    expect(sent[0]?.text).toContain("/emoji-label list")
  })

  it("leaves unknown commands to the model", async () => {
    const { deps, sent } = createDeps()
    expect(await handleCommand("/unknown", deps)).toBe(false)
    expect(await handleCommand("普通消息", deps)).toBe(false)
    expect(sent).toHaveLength(0)
  })
})

describe("tuiCommandName", () => {
  it("prefixes every command with qq-", () => {
    expect(tuiCommandName("reset")).toBe("qq-reset")
  })
})

describe("registerTuiCommands", () => {
  it("registers the same commands and reuses their implementations", async () => {
    const added: Array<{ name: string; execute: (input: unknown) => Promise<void> }> = []
    const ctx = {
      command: {
        transform: async (edit: (editor: { add: (item: unknown) => void }) => void) => {
          edit({ add: (item) => added.push(item as (typeof added)[number]) })
          return { dispose: async () => {} }
        },
      },
      tool: { list: async () => [{ id: "read" }, { id: "qq_send_message" }] },
    } as unknown as Plugin.Context

    const sent: Sent[] = []
    const client = {
      api: {
        sendPrivateMessage: async (id: number, text: string) => {
          sent.push({ target: { kind: "private", id }, text })
        },
        sendGroupMessage: async (id: number, text: string) => {
          sent.push({ target: { kind: "group", id }, text })
        },
      },
    } as unknown as Parameters<typeof registerTuiCommands>[0]["client"]
    const manager = {
      targetForSession: () => ({ kind: "private" as const, id: 200 }),
      snapshot: () => [],
      resetTarget: vi.fn(),
    } as unknown as SessionManager
    const limiter = { pace: async () => {} } as unknown as SendRateLimiter

    await registerTuiCommands({
      ctx,
      config,
      logger,
      manager,
      policy: new ToolPolicy(join(tmpdir(), "qq-policy-commands", "none.json"), logger),
      overrides: new ChatOverrides(join(tmpdir(), "qq-overrides-commands", "none.json"), logger),
      client,
      limiter,
      commands: COMMANDS,
    })

    expect(added.map((item) => item.name)).toEqual(
      COMMANDS.map((command) => tuiCommandName(command.name)),
    )

    const help = added.find((item) => item.name === "qq-help")
    expect(help).toBeDefined()
    await help!.execute({ sessionID: "session-1", prompt: { text: "" } })

    const { deps, sent: qqSent } = createDeps()
    await handleCommand("/help", deps)
    expect(sent[0]?.text).toBe(qqSent[0]?.text)
    expect(sent[0]).toEqual({ target: { kind: "private", id: 200 }, text: expect.any(String) })
  })
})
