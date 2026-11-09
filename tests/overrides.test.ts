import { describe, expect, it, vi } from "vitest"
import { mkdtemp, writeFile, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  chatMuted,
  ChatOverrides,
  defaultChatOverrides,
  DEFAULT_WAKE_POLICY,
  describeOverride,
  parseChatOverrides,
  proactiveAllowed,
  wakeDecision,
  type WakeContext,
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

/** 构造一次唤醒判定需要的消息特征。 */
const ctx = (partial: Partial<WakeContext> = {}): WakeContext => ({
  mentioned: false,
  atAll: false,
  atOthersFirst: false,
  replyToSelf: false,
  text: "",
  ...partial,
})

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

  it("读取主动说话概率", () => {
    const warn = vi.fn()
    const file = parseChatOverrides(
      { chats: { "group:100": { proactiveProbability: 0.25 } } },
      warn,
    )
    expect(file.chats["group:100"]).toEqual({ proactiveProbability: 0.25 })
    expect(warn).not.toHaveBeenCalled()
  })

  it("概率写错时忽略这一项", () => {
    const warn = vi.fn()
    const file = parseChatOverrides(
      {
        chats: {
          "group:100": { proactiveProbability: 1.5 },
          "group:200": { proactiveProbability: "abc" },
        },
      },
      warn,
    )
    expect(file.chats["group:100"]).toEqual({})
    expect(file.chats["group:200"]).toEqual({})
    expect(warn).toHaveBeenCalledTimes(2)
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
    expect(wakeDecision({}, priv(200), ctx({ text: "在吗" }))).toEqual({
      required: true,
      reason: "private",
    })
  })

  it("默认只在被 @ 时必回", () => {
    expect(wakeDecision({}, group(100), ctx({ text: "闲聊" }))).toEqual({ required: false })
    expect(wakeDecision({}, group(100), ctx({ mentioned: true, text: "@机器人 你好" }))).toEqual({
      required: true,
      reason: "mention",
    })
  })

  it("all 让群里每条消息都必回", () => {
    expect(wakeDecision({ wake: "all" }, group(100), ctx({ text: "闲聊" }))).toEqual({
      required: true,
      reason: "all",
    })
  })

  it("none 不必回", () => {
    expect(
      wakeDecision({ wake: "none" }, group(100), ctx({ mentioned: true, text: "@机器人 你好" })),
    ).toEqual({
      required: false,
    })
  })

  it("prefix 只在前缀命中时必回，被 @ 也算", () => {
    const override = { wake: "prefix" as const, prefix: "bot," }
    expect(wakeDecision(override, group(100), ctx({ text: "bot, 查一下" }))).toEqual({
      required: true,
      reason: "prefix",
    })
    expect(wakeDecision(override, group(100), ctx({ text: "  bot, 查一下" }))).toEqual({
      required: true,
      reason: "prefix",
    })
    expect(wakeDecision(override, group(100), ctx({ text: "闲聊" }))).toEqual({ required: false })
    expect(
      wakeDecision(override, group(100), ctx({ mentioned: true, text: "@机器人 你好" })),
    ).toEqual({
      required: true,
      reason: "mention",
    })
  })

  it("全局前缀命中时必回", () => {
    expect(wakeDecision({}, group(100), ctx({ text: "/查一下" }))).toEqual({
      required: true,
      reason: "prefix",
    })
    expect(
      wakeDecision({}, group(100), ctx({ text: "/查一下" }), {
        ...DEFAULT_WAKE_POLICY,
        prefixes: ["bot,"],
      }),
    ).toEqual({ required: false })
  })

  it("@全体成员默认忽略，打开后必回", () => {
    expect(wakeDecision({}, group(100), ctx({ atAll: true, text: "在吗" }))).toEqual({
      required: false,
    })
    expect(
      wakeDecision({}, group(100), ctx({ atAll: true, text: "在吗" }), {
        ...DEFAULT_WAKE_POLICY,
        ignoreAtAll: false,
      }),
    ).toEqual({ required: true, reason: "at_all" })
  })

  it("回复机器人自己时必回", () => {
    expect(wakeDecision({}, group(100), ctx({ replyToSelf: true, text: "继续" }))).toEqual({
      required: true,
      reason: "reply",
    })
    expect(
      wakeDecision({}, group(100), ctx({ replyToSelf: true, text: "继续" }), {
        ...DEFAULT_WAKE_POLICY,
        replyToSelf: false,
      }),
    ).toEqual({ required: false })
  })

  it("群里第一个 @ 的是别人时不唤醒", () => {
    expect(
      wakeDecision({}, group(100), ctx({ atOthersFirst: true, text: "@张三 帮忙看下" })),
    ).toEqual({ required: false, suppress: true })
  })

  it("明确 @ 机器人时不受“@了别人”影响", () => {
    expect(
      wakeDecision({}, group(100), ctx({ mentioned: true, atOthersFirst: true, text: "@机器人" })),
    ).toEqual({ required: true, reason: "mention" })
  })

  it("聊天写死 all 时不受“@了别人”影响", () => {
    expect(
      wakeDecision({ wake: "all" }, group(100), ctx({ atOthersFirst: true, text: "@张三" })),
    ).toEqual({ required: true, reason: "all" })
  })

  it("关掉“@了别人就不理”之后照旧判定", () => {
    expect(
      wakeDecision({}, group(100), ctx({ atOthersFirst: true, text: "@张三 帮忙看下" }), {
        ...DEFAULT_WAKE_POLICY,
        ignoreAtOthers: false,
      }),
    ).toEqual({ required: false })
  })
})

describe("proactiveAllowed", () => {
  it("白名单为空时默认拒绝", () => {
    expect(proactiveAllowed({}, group(100), { allowGroups: [], allowUsers: [] })).toBe(false)
    expect(proactiveAllowed({}, priv(200), { allowGroups: [100], allowUsers: [] })).toBe(false)
  })

  it("显式关掉后不主动说话", () => {
    const scope = { allowGroups: [100], allowUsers: [] }
    expect(proactiveAllowed({ proactive: false }, group(100), scope)).toBe(false)
  })

  it("静音的群也不主动说话", () => {
    expect(
      proactiveAllowed({ wake: "none" }, group(100), { allowGroups: [100], allowUsers: [] }),
    ).toBe(false)
    expect(
      proactiveAllowed({ wake: "none" }, priv(200), { allowGroups: [], allowUsers: [200] }),
    ).toBe(true)
  })

  it("白名单只放行名单里的聊天", () => {
    const scope = { allowGroups: [100], allowUsers: [] }
    expect(proactiveAllowed({}, group(100), scope)).toBe(true)
    expect(proactiveAllowed({}, group(200), scope)).toBe(false)
    expect(proactiveAllowed({}, group(200), { allowGroups: [], allowUsers: [] })).toBe(false)
    expect(proactiveAllowed({}, priv(200), { allowGroups: [], allowUsers: [300] })).toBe(false)
  })

  it("写死打开的聊天不受白名单限制", () => {
    const scope = { allowGroups: [100], allowUsers: [] }
    expect(proactiveAllowed({ proactive: true }, group(200), scope)).toBe(true)
    // 写死关掉的聊天永远不主动说话。
    expect(proactiveAllowed({ proactive: false }, group(100), scope)).toBe(false)
  })
})

describe("describeOverride", () => {
  it("说明唤醒方式与主动说话", () => {
    expect(describeOverride({})).toBe("唤醒 mention（默认），主动说话跟随白名单")
    expect(describeOverride({ wake: "prefix", prefix: "bot," })).toBe(
      "唤醒 prefix，前缀 bot,，主动说话跟随白名单",
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
      "唤醒 mention（默认），主动说话跟随白名单，agent reviewer，模型 anthropic/claude-sonnet-4，角色设定 souls/reviewer.txt",
    )
  })

  it("说明主动说话概率", () => {
    expect(describeOverride({ proactiveProbability: 0.2 })).toBe(
      "唤醒 mention（默认），主动说话跟随白名单，主动概率 0.2",
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
