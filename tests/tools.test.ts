import { describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin"
import { registerTools, TOOL_NAMESPACE } from "../src/tools/qq"
import { DEFAULT_CONFIG, type QQBotConfig } from "../src/config"
import type { ChatTarget } from "../src/chat"
import type { Logger } from "../src/logger"
import type { QQClient } from "../src/naplink/client"
import type { SessionManager } from "../src/session/manager"

interface ToolDefinition {
  name: string
  execute: (raw: unknown, context: { sessionID: string }) => Promise<{ content: string }>
}

interface Harness {
  tools: Map<string, ToolDefinition>
  api: Record<string, ReturnType<typeof vi.fn>>
  manager: {
    targetForSession: ReturnType<typeof vi.fn>
    markMessageSent: ReturnType<typeof vi.fn>
    hasActiveTurn: ReturnType<typeof vi.fn>
    rememberOutgoing: ReturnType<typeof vi.fn>
    isOutgoing: ReturnType<typeof vi.fn>
    isKnownMessage: ReturnType<typeof vi.fn>
  }
  logger: Record<keyof Logger, ReturnType<typeof vi.fn>>
}

const group = (id: number): ChatTarget => ({ kind: "group", id })
const privateChat = (id: number): ChatTarget => ({ kind: "private", id })

async function createHarness(
  target: ChatTarget | null = group(100),
  configOverrides: Partial<QQBotConfig> = {},
): Promise<Harness> {
  const tools = new Map<string, ToolDefinition>()
  const api = {
    sendGroupMessage: vi.fn(async () => ({})),
    sendPrivateMessage: vi.fn(async () => ({})),
    sendGroupForwardMessage: vi.fn(async () => ({})),
    sendPrivateForwardMessage: vi.fn(async () => ({})),
    sendGroupPoke: vi.fn(async () => ({})),
    sendFriendPoke: vi.fn(async () => ({})),
    deleteMessage: vi.fn(async () => ({})),
    getGroupMemberInfo: vi.fn(async () => ({ card: "名片", nickname: "昵称" })),
    getStrangerInfo: vi.fn(async () => ({ nickname: "陌生人" })),
    fetchPttText: vi.fn(async () => ({ text: "语音转写" })),
    getLoginInfo: vi.fn(async () => ({ user_id: 123, nickname: "机器人" })),
  }
  const manager = {
    targetForSession: vi.fn(() => target ?? undefined),
    markMessageSent: vi.fn(),
    hasActiveTurn: vi.fn(() => true),
    rememberOutgoing: vi.fn(),
    isOutgoing: vi.fn(() => true),
    isKnownMessage: vi.fn(() => true),
  }
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const ctx = {
    tool: {
      transform: vi.fn(async (callback: (editor: unknown) => void) => {
        callback({
          namespace: vi.fn(),
          add: (tool: ToolDefinition & { options?: { namespace?: string } }) => {
            tools.set(`${tool.options?.namespace ?? ""}_${tool.name}`, tool)
          },
        })
        return { dispose: async () => {} }
      }),
    },
  } as unknown as Plugin.Context

  const config: QQBotConfig = {
    ...DEFAULT_CONFIG,
    napcat: { url: "ws://127.0.0.1:3001" },
    groups: [100],
    users: [200],
    sendDelayMs: 0,
    ...configOverrides,
  }

  await registerTools({
    ctx,
    config,
    logger: logger as unknown as Logger,
    manager: manager as unknown as SessionManager,
    client: { api } as unknown as QQClient,
  })

  return { tools, api, manager, logger }
}

const context = { sessionID: "session-1" }

describe("registerTools", () => {
  it("registers every tool under the qq namespace", async () => {
    const { tools } = await createHarness()
    expect([...tools.keys()].sort()).toEqual([
      "qq_delete_message",
      "qq_fetch_ptt_text",
      "qq_get_group_member_info",
      "qq_get_login_info",
      "qq_send_forward",
      "qq_send_image",
      "qq_send_message",
      "qq_send_poke",
      "qq_send_record",
    ])
  })

  it("keeps the message formatting in one send", async () => {
    const { tools, api } = await createHarness()
    const result = await tools
      .get(`${TOOL_NAMESPACE}_send_message`)
      ?.execute({ content: "第一行\n\n第二行" }, context)
    expect(result?.content).toBe("sent")
    expect(api["sendGroupMessage"]).toHaveBeenCalledTimes(1)
    expect(api["sendGroupMessage"]).toHaveBeenCalledWith(100, "第一行\n\n第二行")
  })

  it("skips sending when the model chooses not to reply", async () => {
    const { tools, api, manager } = await createHarness()
    const result = await tools
      .get(`${TOOL_NAMESPACE}_send_message`)
      ?.execute({ content: "算了", reply: false }, context)
    expect(result?.content).toBe("skipped")
    expect(api["sendGroupMessage"]).not.toHaveBeenCalled()
    expect(manager.markMessageSent).toHaveBeenCalledWith("session-1")
  })

  it("skips sending empty content", async () => {
    const { tools, api } = await createHarness()
    const result = await tools
      .get(`${TOOL_NAMESPACE}_send_message`)
      ?.execute({ content: "   " }, context)
    expect(result?.content).toBe("skipped")
    expect(api["sendGroupMessage"]).not.toHaveBeenCalled()
  })

  it("warns about content longer than the limit", async () => {
    const { tools, logger } = await createHarness()
    await tools
      .get(`${TOOL_NAMESPACE}_send_message`)
      ?.execute({ content: "长".repeat(DEFAULT_CONFIG.warnLength + 1) }, context)
    expect(logger.warn).toHaveBeenCalled()
  })

  it("reports an error for sessions without a chat target", async () => {
    const { tools, api } = await createHarness(null)
    const result = await tools
      .get(`${TOOL_NAMESPACE}_send_message`)
      ?.execute({ content: "你好" }, context)
    expect(result?.content).toContain("error")
    expect(api["sendGroupMessage"]).not.toHaveBeenCalled()
  })

  it("sends an image segment", async () => {
    const { tools, api } = await createHarness()
    const result = await tools
      .get(`${TOOL_NAMESPACE}_send_image`)
      ?.execute({ file: "https://example.com/a.png" }, context)
    expect(result?.content).toBe("sent")
    expect(api["sendGroupMessage"]).toHaveBeenCalledWith(100, [
      { type: "image", data: { file: "https://example.com/a.png" } },
    ])
  })

  it("rejects an image without a file", async () => {
    const { tools } = await createHarness()
    const result = await tools.get(`${TOOL_NAMESPACE}_send_image`)?.execute({}, context)
    expect(result?.content).toContain("error")
  })

  it("rejects a forward without nodes", async () => {
    const { tools } = await createHarness()
    const result = await tools
      .get(`${TOOL_NAMESPACE}_send_forward`)
      ?.execute({ nodes: [] }, context)
    expect(result?.content).toContain("error")
  })

  it("returns the group member info", async () => {
    const { tools } = await createHarness()
    const result = await tools
      .get(`${TOOL_NAMESPACE}_get_group_member_info`)
      ?.execute({ user_id: "200" }, context)
    expect(result?.content).toContain("名片")
  })

  it("transcribes a voice message", async () => {
    const { tools } = await createHarness()
    const result = await tools
      .get(`${TOOL_NAMESPACE}_fetch_ptt_text`)
      ?.execute({ message_id: "5" }, context)
    expect(result?.content).toBe("语音转写")
  })

  it("returns the login info", async () => {
    const { tools } = await createHarness()
    const result = await tools.get(`${TOOL_NAMESPACE}_get_login_info`)?.execute({}, context)
    expect(result?.content).toContain("123")
  })

  it("marks media replies as sent", async () => {
    const { tools, manager } = await createHarness()
    await tools.get(`${TOOL_NAMESPACE}_send_image`)?.execute({ file: "a.png" }, context)
    await tools.get(`${TOOL_NAMESPACE}_send_record`)?.execute({ file: "a.amr" }, context)
    await tools.get(`${TOOL_NAMESPACE}_send_poke`)?.execute({ user_id: "200" }, context)
    expect(manager.markMessageSent).toHaveBeenCalledTimes(3)
  })

  it("rejects deleting a message the bot did not send", async () => {
    const { tools, api, manager } = await createHarness()
    manager.isOutgoing.mockReturnValue(false)
    const result = await tools
      .get(`${TOOL_NAMESPACE}_delete_message`)
      ?.execute({ message_id: "5" }, context)
    expect(result?.content).toContain("error")
    expect(api["deleteMessage"]).not.toHaveBeenCalled()
  })

  it("rejects tools for groups removed from the config", async () => {
    const { tools, api } = await createHarness(group(100), { groups: [200] })
    const result = await tools
      .get(`${TOOL_NAMESPACE}_send_message`)
      ?.execute({ content: "你好" }, context)
    expect(result?.content).toContain("error")
    expect(api["sendGroupMessage"]).not.toHaveBeenCalled()
  })

  it("rejects tools outside an active QQ turn", async () => {
    const { tools, api, manager } = await createHarness()
    manager.hasActiveTurn.mockReturnValue(false)
    const result = await tools
      .get(`${TOOL_NAMESPACE}_send_message`)
      ?.execute({ content: "你好" }, context)
    expect(result?.content).toContain("error")
    expect(api["sendGroupMessage"]).not.toHaveBeenCalled()
  })

  it("rejects transcribing an unknown message", async () => {
    const { tools, api, manager } = await createHarness()
    manager.isKnownMessage.mockReturnValue(false)
    const result = await tools
      .get(`${TOOL_NAMESPACE}_fetch_ptt_text`)
      ?.execute({ message_id: "5" }, context)
    expect(result?.content).toContain("error")
    expect(api["fetchPttText"]).not.toHaveBeenCalled()
  })

  it("rejects an invalid forward user id", async () => {
    const { tools, api } = await createHarness()
    const result = await tools
      .get(`${TOOL_NAMESPACE}_send_forward`)
      ?.execute({ nodes: [{ user_id: "abc", content: "内容" }] }, context)
    expect(result?.content).toContain("error")
    expect(api["sendGroupForwardMessage"]).not.toHaveBeenCalled()
  })

  it("accepts reply=false without content", async () => {
    const { tools, manager } = await createHarness()
    const result = await tools
      .get(`${TOOL_NAMESPACE}_send_message`)
      ?.execute({ reply: false }, context)
    expect(result?.content).toBe("skipped")
    expect(manager.markMessageSent).toHaveBeenCalledWith("session-1")
  })

  describe("private chats", () => {
    it("sends text to the private chat", async () => {
      const { tools, api } = await createHarness(privateChat(200))
      const result = await tools
        .get(`${TOOL_NAMESPACE}_send_message`)
        ?.execute({ content: "私聊你好" }, context)
      expect(result?.content).toBe("sent")
      expect(api["sendPrivateMessage"]).toHaveBeenCalledWith(200, "私聊你好")
      expect(api["sendGroupMessage"]).not.toHaveBeenCalled()
    })

    it("sends media to the private chat", async () => {
      const { tools, api } = await createHarness(privateChat(200))
      await tools.get(`${TOOL_NAMESPACE}_send_image`)?.execute({ file: "a.png" }, context)
      expect(api["sendPrivateMessage"]).toHaveBeenCalledWith(200, [
        { type: "image", data: { file: "a.png" } },
      ])
    })

    it("sends a private forward", async () => {
      const { tools, api } = await createHarness(privateChat(200))
      const result = await tools
        .get(`${TOOL_NAMESPACE}_send_forward`)
        ?.execute({ nodes: [{ user_id: "1", content: "内容" }] }, context)
      expect(result?.content).toBe("sent")
      expect(api["sendPrivateForwardMessage"]).toHaveBeenCalledWith({
        user_id: 200,
        messages: [
          {
            user_id: 1,
            nickname: "未知用户",
            content: [{ type: "text", data: { text: "内容" } }],
          },
        ],
      })
    })

    it("pokes through the friend API", async () => {
      const { tools, api } = await createHarness(privateChat(200))
      const result = await tools
        .get(`${TOOL_NAMESPACE}_send_poke`)
        ?.execute({ user_id: "300" }, context)
      expect(result?.content).toBe("sent")
      expect(api["sendFriendPoke"]).toHaveBeenCalledWith("300")
      expect(api["sendGroupPoke"]).not.toHaveBeenCalled()
    })

    it("returns stranger info in a private chat", async () => {
      const { tools, api } = await createHarness(privateChat(200))
      const result = await tools
        .get(`${TOOL_NAMESPACE}_get_group_member_info`)
        ?.execute({ user_id: "300" }, context)
      expect(result?.content).toContain("陌生人")
      expect(api["getStrangerInfo"]).toHaveBeenCalledWith("300")
      expect(api["getGroupMemberInfo"]).not.toHaveBeenCalled()
    })

    it("rejects private chats removed from the config", async () => {
      const { tools, api } = await createHarness(privateChat(300), { users: [200] })
      const result = await tools
        .get(`${TOOL_NAMESPACE}_send_message`)
        ?.execute({ content: "你好" }, context)
      expect(result?.content).toContain("error")
      expect(api["sendPrivateMessage"]).not.toHaveBeenCalled()
    })
  })
})
