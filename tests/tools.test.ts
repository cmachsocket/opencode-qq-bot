import { describe, expect, it, vi } from "vitest"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { registerTools, TOOL_NAMESPACE } from "../src/tools/qq"
import { DEFAULT_CONFIG, type QQBotConfig } from "../src/config"
import type { ChatTarget } from "../src/chat"
import type { CustomFace } from "../src/emoji/favorites"
import { FavoriteIndex, type IndexStorage } from "../src/emoji/favorite-index"
import type { Logger } from "../src/logger"
import { OutboundMedia } from "../src/media-path"
import type { QQClient } from "../src/naplink/client"
import { SendRateLimiter } from "../src/rate-limit"
import { SensitiveChecker } from "../src/sensitive"
import type { SessionManager } from "../src/session/manager"

interface ToolDefinition {
  name: string
  execute: (raw: unknown, context: { sessionID: string }) => Promise<{ content: string }>
}

interface Harness {
  tools: Map<string, ToolDefinition>
  api: Record<string, ReturnType<typeof vi.fn>>
  favorites: { list: ReturnType<typeof vi.fn> }
  manager: {
    targetForSession: ReturnType<typeof vi.fn>
    markMessageSent: ReturnType<typeof vi.fn>
    hasActiveTurn: ReturnType<typeof vi.fn>
    rememberOutgoing: ReturnType<typeof vi.fn>
    isOutgoing: ReturnType<typeof vi.fn>
    isKnownMessage: ReturnType<typeof vi.fn>
  }
  logger: Record<keyof Logger, ReturnType<typeof vi.fn>>
  /** 临时工作目录，媒体文件都放在这里。 */
  workspace: string
}

const group = (id: number): ChatTarget => ({ kind: "group", id })
const privateChat = (id: number): ChatTarget => ({ kind: "private", id })

const stickerFaces: CustomFace[] = [
  {
    emoId: 0,
    resId: "res-0",
    url: "https://example.com/sticker-0.png",
    md5: "md5-0",
    desc: "猫猫摊手",
  },
]

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
    rateLimit: { maxPerMinute: 0, maxPerHour: 0, minGapMs: 0 },
    ...configOverrides,
  }

  const favorites = {
    list: vi.fn(async () => stickerFaces),
  }

  const storage = new Map<string, unknown>()
  const favoriteIndex = new FavoriteIndex(
    {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
    } as unknown as IndexStorage,
    logger as unknown as Logger,
  )

  const workspace = await mkdtemp(join(tmpdir(), "qq-bot-tools-"))
  for (const name of ["a.png", "b.png", "a.amr"]) {
    await writeFile(join(workspace, name), "media")
  }
  const outbound = new OutboundMedia({ workspace, allowedDirs: [workspace] })

  await registerTools({
    ctx,
    config,
    logger: logger as unknown as Logger,
    manager: manager as unknown as SessionManager,
    client: { api } as unknown as QQClient,
    favorites: favorites as never,
    favoriteIndex,
    limiter: new SendRateLimiter(config.rateLimit),
    sensitive: new SensitiveChecker({ enabled: config.sensitive.enabled }),
    outbound,
  })

  return { tools, api, favorites, manager, logger, workspace }
}

const context = { sessionID: "session-1" }

describe("registerTools", () => {
  it("registers every tool under the qq namespace", async () => {
    const { tools } = await createHarness()
    expect([...tools.keys()].sort()).toEqual([
      "qq_delete_message",
      "qq_favorite_list",
      "qq_fetch_ptt_text",
      "qq_get_group_member_info",
      "qq_get_login_info",
      "qq_send_forward",
      "qq_send_image",
      "qq_send_message",
      "qq_send_poke",
      "qq_send_record",
      "qq_send_sticker",
    ])
  })

  it("keeps the message formatting in one send", async () => {
    const { tools, api } = await createHarness()
    const result = await tools
      .get(`${TOOL_NAMESPACE}_send_message`)
      ?.execute({ content: "第一行\n\n第二行" }, context)
    expect(result?.content).toBe("你已成功发送消息，可以选择结束对话")
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

  it("blocks outbound messages that contain credentials", async () => {
    const { tools, api, manager } = await createHarness()
    await expect(
      tools
        .get(`${TOOL_NAMESPACE}_send_message`)
        ?.execute({ content: "这是我的密钥 ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, context),
    ).rejects.toThrow("出站消息包含疑似敏感信息")
    expect(api["sendGroupMessage"]).not.toHaveBeenCalled()
    expect(manager.markMessageSent).not.toHaveBeenCalled()
  })

  it("allows ordinary chat with QQ numbers and emails", async () => {
    const { tools, api } = await createHarness()
    const result = await tools
      .get(`${TOOL_NAMESPACE}_send_message`)
      ?.execute({ content: "我的QQ号是123456789，邮箱 foo@example.com" }, context)
    expect(result?.content).toBe("你已成功发送消息，可以选择结束对话")
    expect(api["sendGroupMessage"]).toHaveBeenCalledTimes(1)
  })

  it("blocks image paths that point at credential files", async () => {
    const { tools, api } = await createHarness()
    await expect(
      tools
        .get(`${TOOL_NAMESPACE}_send_image`)
        ?.execute({ file: "/home/user/.ssh/id_rsa" }, context),
    ).rejects.toThrow("出站消息包含疑似敏感信息")
    expect(api["sendGroupMessage"]).not.toHaveBeenCalled()
  })

  it("blocks forward nodes that contain credentials", async () => {
    const { tools, api } = await createHarness()
    await expect(
      tools.get(`${TOOL_NAMESPACE}_send_forward`)?.execute(
        {
          nodes: [{ nickname: "甲", content: "password = hunter2000" }],
        },
        context,
      ),
    ).rejects.toThrow("出站消息包含疑似敏感信息")
    expect(api["sendGroupForwardMessage"]).not.toHaveBeenCalled()
  })

  it("blocks forward nicknames that contain credentials", async () => {
    const { tools, api } = await createHarness()
    await expect(
      tools.get(`${TOOL_NAMESPACE}_send_forward`)?.execute(
        {
          nodes: [{ nickname: "password = hunter2000", content: "你好" }],
        },
        context,
      ),
    ).rejects.toThrow("出站消息包含疑似敏感信息")
    expect(api["sendGroupForwardMessage"]).not.toHaveBeenCalled()
  })

  it("does not block when the sensitive check is disabled", async () => {
    const { tools, api } = await createHarness(group(100), {
      sensitive: { enabled: false },
    })
    const result = await tools
      .get(`${TOOL_NAMESPACE}_send_message`)
      ?.execute({ content: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, context)
    expect(result?.content).toBe("你已成功发送消息，可以选择结束对话")
    expect(api["sendGroupMessage"]).toHaveBeenCalledTimes(1)
  })

  it("strips markdown before sending", async () => {
    const { tools, api } = await createHarness()
    await tools
      .get(`${TOOL_NAMESPACE}_send_message`)
      ?.execute({ content: "# 标题\n\n- 第一项" }, context)
    expect(api["sendGroupMessage"]).toHaveBeenCalledWith(100, "标题\n\n第一项")
  })

  it("keeps the url of a link", async () => {
    const { tools, api } = await createHarness()
    await tools
      .get(`${TOOL_NAMESPACE}_send_message`)
      ?.execute({ content: "[文档](https://example.com/doc)" }, context)
    expect(api["sendGroupMessage"]).toHaveBeenCalledWith(100, "文档: https://example.com/doc")
  })

  it("skips sending content that is only a table", async () => {
    const { tools, api, manager } = await createHarness()
    const result = await tools
      .get(`${TOOL_NAMESPACE}_send_message`)
      ?.execute({ content: "| a | b |\n| --- | --- |\n| 1 | 2 |" }, context)
    expect(result?.content).toBe("skipped")
    expect(api["sendGroupMessage"]).not.toHaveBeenCalled()
    expect(manager.markMessageSent).toHaveBeenCalledWith("session-1")
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
    const url = "https://93.184.216.34/a.png"
    const result = await tools.get(`${TOOL_NAMESPACE}_send_image`)?.execute({ file: url }, context)
    expect(result?.content).toBe("你已成功发送图片，可以选择结束对话")
    // 远端地址原样交给 NapCat，它自己去拉。
    expect(api["sendGroupMessage"]).toHaveBeenCalledWith(100, [
      { type: "image", data: { file: url } },
    ])
  })

  it("refuses a remote address pointing at the intranet", async () => {
    const { tools, api } = await createHarness()
    await expect(
      tools
        .get(`${TOOL_NAMESPACE}_send_image`)
        ?.execute({ file: "http://127.0.0.1:8080/a.png" }, context),
    ).rejects.toThrow("指向内网")
    expect(api["sendGroupMessage"]).not.toHaveBeenCalled()
  })

  it("sends inline base64 images unchanged", async () => {
    const { tools, api } = await createHarness()
    const result = await tools
      .get(`${TOOL_NAMESPACE}_send_image`)
      ?.execute({ base64: "AAAA" }, context)
    expect(result?.content).toBe("你已成功发送图片，可以选择结束对话")
    const call = api["sendGroupMessage"]?.mock.calls[0]
    const segments = (call?.[1] ?? []) as { data: { file: string } }[]
    expect(segments[0]?.data.file).toBe("base64://AAAA")
  })

  it("refuses an image outside the allowed directories", async () => {
    const { tools, api } = await createHarness()
    await expect(
      tools.get(`${TOOL_NAMESPACE}_send_image`)?.execute({ file: "/etc/passwd" }, context),
    ).rejects.toThrow("不在允许的目录内")
    expect(api["sendGroupMessage"]).not.toHaveBeenCalled()
  })

  it("rejects an image without a file", async () => {
    const { tools } = await createHarness()
    const result = await tools.get(`${TOOL_NAMESPACE}_send_image`)?.execute({}, context)
    expect(result?.content).toContain("error")
  })

  it("lists the favorite stickers with their ids", async () => {
    const { tools } = await createHarness()
    const result = await tools.get(`${TOOL_NAMESPACE}_favorite_list`)?.execute({}, context)
    expect(result?.content).toBe("收藏表情（编号即发送用的 id，共 1 个）\n1. 猫猫摊手")
  })

  it("sends a favorite sticker as a custom face image", async () => {
    const { tools, api } = await createHarness()
    const result = await tools.get(`${TOOL_NAMESPACE}_send_sticker`)?.execute({ id: 1 }, context)
    expect(result?.content).toBe("你已成功发送收藏表情 1「猫猫摊手」，可以选择结束对话")
    expect(api["sendGroupMessage"]).toHaveBeenCalledWith(100, [
      {
        type: "image",
        data: { file: "https://example.com/sticker-0.png", sub_type: 1 },
      },
    ])
  })

  it("rejects a sticker without an id", async () => {
    const { tools, api } = await createHarness()
    const result = await tools.get(`${TOOL_NAMESPACE}_send_sticker`)?.execute({}, context)
    expect(result?.content).toContain("error")
    expect(api["sendGroupMessage"]).not.toHaveBeenCalled()
  })

  it("reports an unknown sticker id", async () => {
    const { tools, api } = await createHarness()
    const result = await tools.get(`${TOOL_NAMESPACE}_send_sticker`)?.execute({ id: 99 }, context)
    expect(result?.content).toContain("error")
    expect(result?.content).toContain("1(猫猫摊手)")
    expect(api["sendGroupMessage"]).not.toHaveBeenCalled()
  })

  it("rejects a forward without nodes", async () => {
    const { tools } = await createHarness()
    const result = await tools
      .get(`${TOOL_NAMESPACE}_send_forward`)
      ?.execute({ nodes: [] }, context)
    expect(result?.content).toContain("error")
  })

  it("strips markdown from the forward nodes", async () => {
    const { tools, api } = await createHarness()
    await tools
      .get(`${TOOL_NAMESPACE}_send_forward`)
      ?.execute({ nodes: [{ user_id: "1", nickname: "甲", content: "**转发**" }] }, context)
    expect(api["sendGroupForwardMessage"]).toHaveBeenCalledWith(100, [
      {
        user_id: 1,
        nickname: "甲",
        content: [{ type: "text", data: { text: "转发" } }],
      },
    ])
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
    const { tools, manager, workspace } = await createHarness()
    await tools
      .get(`${TOOL_NAMESPACE}_send_image`)
      ?.execute({ file: join(workspace, "a.png") }, context)
    await tools
      .get(`${TOOL_NAMESPACE}_send_record`)
      ?.execute({ file: join(workspace, "a.amr") }, context)
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

  describe("出站限流", () => {
    it("超过每分钟上限时拒绝发送，并标记本轮已回复", async () => {
      const { tools, api, manager } = await createHarness(group(100), {
        rateLimit: { maxPerMinute: 1, maxPerHour: 0, minGapMs: 0 },
      })
      const first = await tools
        .get(`${TOOL_NAMESPACE}_send_message`)
        ?.execute({ content: "第一条" }, context)
      expect(first?.content).toContain("你已成功发送消息")
      const second = await tools
        .get(`${TOOL_NAMESPACE}_send_message`)
        ?.execute({ content: "第二条" }, context)
      expect(second?.content).toContain("发送频率超限")
      expect(api["sendGroupMessage"]).toHaveBeenCalledTimes(1)
      // 被限流也要算已回复，否则模型会被反复提醒补发。
      expect(manager.markMessageSent).toHaveBeenCalledTimes(2)
    })

    it("图片发送同样受限", async () => {
      const { tools, api, workspace } = await createHarness(group(100), {
        rateLimit: { maxPerMinute: 1, maxPerHour: 0, minGapMs: 0 },
      })
      await tools
        .get(`${TOOL_NAMESPACE}_send_image`)
        ?.execute({ file: join(workspace, "a.png") }, context)
      const result = await tools
        .get(`${TOOL_NAMESPACE}_send_image`)
        ?.execute({ file: join(workspace, "b.png") }, context)
      expect(result?.content).toContain("发送频率超限")
      expect(api["sendGroupMessage"]).toHaveBeenCalledTimes(1)
    })

    it("超长消息按段计数", async () => {
      const { tools, api } = await createHarness(group(100), {
        rateLimit: { maxPerMinute: 1, maxPerHour: 0, minGapMs: 0 },
      })
      const result = await tools
        .get(`${TOOL_NAMESPACE}_send_message`)
        ?.execute({ content: "长".repeat(5000) }, context)
      expect(result?.content).toContain("已发送 1/2 段")
      expect(api["sendGroupMessage"]).toHaveBeenCalledTimes(1)
    })

    it("不同目标各自计数", async () => {
      const { tools, api, manager } = await createHarness(group(100), {
        rateLimit: { maxPerMinute: 1, maxPerHour: 0, minGapMs: 0 },
      })
      manager.targetForSession.mockImplementation((sessionID: string) =>
        sessionID === "session-2" ? privateChat(200) : group(100),
      )
      await tools.get(`${TOOL_NAMESPACE}_send_message`)?.execute({ content: "群消息" }, context)
      const privateResult = await tools
        .get(`${TOOL_NAMESPACE}_send_message`)
        ?.execute({ content: "私聊消息" }, { sessionID: "session-2" })
      expect(privateResult?.content).toContain("你已成功发送消息")
      expect(api["sendPrivateMessage"]).toHaveBeenCalledTimes(1)
    })
  })

  describe("private chats", () => {
    it("sends text to the private chat", async () => {
      const { tools, api } = await createHarness(privateChat(200))
      const result = await tools
        .get(`${TOOL_NAMESPACE}_send_message`)
        ?.execute({ content: "私聊你好" }, context)
      expect(result?.content).toBe("你已成功发送消息，可以选择结束对话")
      expect(api["sendPrivateMessage"]).toHaveBeenCalledWith(200, "私聊你好")
      expect(api["sendGroupMessage"]).not.toHaveBeenCalled()
    })

    it("sends media to the private chat", async () => {
      const { tools, api, workspace } = await createHarness(privateChat(200))
      const file = join(workspace, "a.png")
      await tools.get(`${TOOL_NAMESPACE}_send_image`)?.execute({ file }, context)
      expect(api["sendPrivateMessage"]).toHaveBeenCalledWith(200, [
        { type: "image", data: { file } },
      ])
    })

    it("sends a private forward", async () => {
      const { tools, api } = await createHarness(privateChat(200))
      const result = await tools
        .get(`${TOOL_NAMESPACE}_send_forward`)
        ?.execute({ nodes: [{ user_id: "1", content: "内容" }] }, context)
      expect(result?.content).toBe("你已成功发送合并转发消息，可以选择结束对话")
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
      expect(result?.content).toBe("你已成功戳一下用户，可以选择结束对话")
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
