import { describe, expect, it, vi } from "vitest"
import { mkdtemp, writeFile, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  chatMuted,
  ChatOverrides,
  defaultChatOverrides,
  describeOverride,
  parseChatOverrides,
  proactiveAllowed,
  wakeDecision,
} from "../src/overrides"
import type { Logger } from "../src/logger"

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const group = (id: number) => ({ kind: "group" as const, id })
const priv = (id: number) => ({ kind: "private" as const, id })

describe("parseChatOverrides", () => {
  it("忽略不是对象的配置", () => {
    const warn = vi.fn()
    expect(parseChatOverrides("nope", warn)).toEqual(defaultChatOverrides())
    expect(warn).toHaveBeenCalled()
  })

  it("chats 不是对象时忽略", () => {
    const warn = vi.fn()
    expect(parseChatOverrides({ chats: [] }, warn)).toEqual(defaultChatOverrides())
    expect(warn).toHaveBeenCalled()
  })

  it("读取合法的覆盖项", () => {
    const warn = vi.fn()
    const file = parseChatOverrides(
      { chats: { "group:100": { wake: "prefix", prefix: "bot,", proactive: false } } },
      warn,
    )
    expect(file.chats["group:100"]).toEqual({ wake: "prefix", prefix: "bot,", proactive: false })
    expect(warn).not.toHaveBeenCalled()
  })

  it("写错的字段只忽略这一项", () => {
    const warn = vi.fn()
    const file = parseChatOverrides(
      { chats: { "group:100": { wake: "loud", proactive: "yes" } } },
      warn,
    )
    expect(file.chats["group:100"]).toEqual({})
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it("读取 agent、model 与 soul 覆盖", () => {
    const warn = vi.fn()
    const file = parseChatOverrides(
      {
        chats: {
          "group:100": {
            agent: "reviewer",
            model: "anthropic/claude-sonnet-4",
            soul: "souls/reviewer.txt",
          },
        },
      },
      warn,
    )
    expect(file.chats["group:100"]).toEqual({
      agent: "reviewer",
      model: { providerID: "anthropic", id: "claude-sonnet-4" },
      soul: "souls/reviewer.txt",
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it("model 带 variant 时保留 variant", () => {
    const warn = vi.fn()
    const file = parseChatOverrides(
      { chats: { "group:100": { model: "openai/gpt-5#high" } } },
      warn,
    )
    expect(file.chats["group:100"]?.model).toEqual({
      providerID: "openai",
      id: "gpt-5",
      variant: "high",
    })
  })

  it("写错的 agent、model 与 soul 只忽略这一项", () => {
    const warn = vi.fn()
    const file = parseChatOverrides(
      {
        chats: {
          "group:100": { agent: "", model: "没有斜杠", soul: "  " },
        },
      },
      warn,
    )
    expect(file.chats["group:100"]).toEqual({})
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it("prefix 唤醒缺前缀时退回被 @ 才必回", () => {
    const warn = vi.fn()
    const file = parseChatOverrides({ chats: { "group:100": { wake: "prefix" } } }, warn)
    expect(file.chats["group:100"]).toEqual({})
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("prefix"))
  })
})

describe("chatMuted", () => {
  it("只有群聊的 none 才静音", () => {
    expect(chatMuted({ wake: "none" }, group(100))).toBe(true)
    expect(chatMuted({ wake: "none" }, priv(200))).toBe(false)
    expect(chatMuted({ wake: "all" }, group(100))).toBe(false)
  })
})

describe("wakeDecision", () => {
  it("私聊永远必回", () => {
    expect(wakeDecision({}, priv(200), false, "在吗")).toEqual({
      required: true,
      reason: "private",
    })
  })

  it("默认只在被 @ 时必回", () => {
    expect(wakeDecision({}, group(100), false, "闲聊")).toEqual({ required: false })
    expect(wakeDecision({}, group(100), true, "@机器人 你好")).toEqual({
      required: true,
      reason: "mention",
    })
  })

  it("all 让群里每条消息都必回", () => {
    expect(wakeDecision({ wake: "all" }, group(100), false, "闲聊")).toEqual({
      required: true,
      reason: "all",
    })
  })

  it("none 不必回", () => {
    expect(wakeDecision({ wake: "none" }, group(100), true, "@机器人 你好")).toEqual({
      required: false,
    })
  })

  it("prefix 只在前缀命中时必回，被 @ 也算", () => {
    const override = { wake: "prefix" as const, prefix: "bot," }
    expect(wakeDecision(override, group(100), false, "bot, 查一下")).toEqual({
      required: true,
      reason: "prefix",
    })
    expect(wakeDecision(override, group(100), false, "  bot, 查一下")).toEqual({
      required: true,
      reason: "prefix",
    })
    expect(wakeDecision(override, group(100), false, "闲聊")).toEqual({ required: false })
    expect(wakeDecision(override, group(100), true, "@机器人 你好")).toEqual({
      required: true,
      reason: "mention",
    })
  })
})

describe("proactiveAllowed", () => {
  it("默认允许主动说话", () => {
    expect(proactiveAllowed({}, group(100))).toBe(true)
  })

  it("显式关掉后不主动说话", () => {
    expect(proactiveAllowed({ proactive: false }, group(100))).toBe(false)
    expect(proactiveAllowed({ proactive: true }, group(100))).toBe(true)
  })

  it("静音的群也不主动说话", () => {
    expect(proactiveAllowed({ wake: "none" }, group(100))).toBe(false)
    expect(proactiveAllowed({ wake: "none" }, priv(200))).toBe(true)
  })
})

describe("describeOverride", () => {
  it("说明唤醒方式与主动说话", () => {
    expect(describeOverride({})).toBe("唤醒 mention（默认），允许主动说话")
    expect(describeOverride({ wake: "prefix", prefix: "bot," })).toBe(
      "唤醒 prefix，前缀 bot,，允许主动说话",
    )
    expect(describeOverride({ proactive: false })).toBe("唤醒 mention（默认），不主动说话")
  })

  it("说明 agent、模型与角色设定", () => {
    expect(
      describeOverride({
        agent: "reviewer",
        model: { providerID: "anthropic", id: "claude-sonnet-4" },
        soul: "souls/reviewer.txt",
      }),
    ).toBe(
      "唤醒 mention（默认），允许主动说话，agent reviewer，模型 anthropic/claude-sonnet-4，角色设定 souls/reviewer.txt",
    )
  })
})

describe("ChatOverrides", () => {
  it("文件不存在时没有覆盖", async () => {
    const overrides = new ChatOverrides(join(tmpdir(), "qq-overrides-missing", "none.json"), logger)
    expect(await overrides.current()).toEqual(defaultChatOverrides())
    expect(await overrides.for(group(100))).toEqual({})
  })

  it("按聊天读取覆盖", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qq-overrides-"))
    const path = join(dir, "chat-overrides.json")
    await writeFile(
      path,
      JSON.stringify({
        chats: { "group:100": { wake: "all" }, "private:200": { proactive: false } },
      }),
      "utf8",
    )
    const overrides = new ChatOverrides(path, logger)
    expect(await overrides.for(group(100))).toEqual({ wake: "all" })
    expect(await overrides.for(priv(200))).toEqual({ proactive: false })
    expect(await overrides.for(group(999))).toEqual({})
  })

  it("文件改动后重新读取", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qq-overrides-"))
    const path = join(dir, "chat-overrides.json")
    await writeFile(path, JSON.stringify({ chats: { "group:100": { wake: "all" } } }), "utf8")
    const overrides = new ChatOverrides(path, logger)
    expect(await overrides.for(group(100))).toEqual({ wake: "all" })

    await writeFile(path, JSON.stringify({ chats: { "group:100": { wake: "none" } } }), "utf8")
    const later = new Date(Date.now() + 5_000)
    await utimes(path, later, later)

    expect(await overrides.for(group(100))).toEqual({ wake: "none" })
  })

  it("文件写坏时沿用上一份配置", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qq-overrides-"))
    const path = join(dir, "chat-overrides.json")
    await writeFile(path, JSON.stringify({ chats: { "group:100": { wake: "all" } } }), "utf8")
    const overrides = new ChatOverrides(path, logger)
    expect(await overrides.for(group(100))).toEqual({ wake: "all" })

    await writeFile(path, "{ broken", "utf8")
    const later = new Date(Date.now() + 5_000)
    await utimes(path, later, later)

    expect(await overrides.for(group(100))).toEqual({ wake: "all" })
  })
})
