import { describe, expect, it, vi } from "vitest"
import type { OneBotApi } from "@naplink/naplink"
import type { ChatTarget } from "../src/chat"
import type { Logger } from "../src/logger"
import type { MediaStore } from "../src/naplink/media"
import { createHistoryProvider } from "../src/naplink/history"
import { formatTimestamp } from "../src/model-view"

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const group = (id: number): ChatTarget => ({ kind: "group", id })
const privateChat = (id: number): ChatTarget => ({ kind: "private", id })

/** 造一条历史消息，默认只带一段文本。 */
function message(id: number, time: number, text: string, extra: Record<string, unknown> = {}) {
  return {
    message_id: id,
    time,
    user_id: 42,
    sender: { user_id: 42, nickname: "小明" },
    message: [{ type: "text", data: { text } }],
    ...extra,
  }
}

function createApi(history: (params: unknown) => unknown) {
  return {
    getGroupMsgHistory: vi.fn(async (params: unknown) => history(params)),
    getFriendMsgHistory: vi.fn(async (params: unknown) => history(params)),
    getMessage: vi.fn(),
    fetchPttText: vi.fn(),
  } as unknown as OneBotApi
}

function createProvider(api: OneBotApi) {
  return createHistoryProvider({
    api,
    logger,
    media: {} as MediaStore,
  })
}

describe("createHistoryProvider", () => {
  it("群聊走群历史接口并渲染成 history 块", async () => {
    const api = createApi(() => ({ messages: [message(1, 100, "早上好")] }))
    const history = createProvider(api)
    const result = await history.fetch(group(100), { count: 20 })
    expect(api.getGroupMsgHistory).toHaveBeenCalledWith({
      group_id: 100,
      message_seq: "0",
      count: 20,
      reverse_order: false,
    })
    expect(result.text).toBe(
      `<history>\n之前的聊天记录（按时间顺序）：\n[${formatTimestamp(100)}] 小明(42): 早上好\n</history>`,
    )
    expect(result.files).toEqual([])
  })

  it("私聊走私聊历史接口", async () => {
    const api = createApi(() => ({ messages: [message(1, 100, "在吗")] }))
    const history = createProvider(api)
    await history.fetch(privateChat(200), { count: 20 })
    expect(api.getFriendMsgHistory).toHaveBeenCalledWith({
      user_id: 200,
      message_seq: "0",
      count: 20,
      reverse_order: false,
    })
  })

  it("兼容裸数组返回并按时间从旧到新排序", async () => {
    const api = createApi(() => [
      message(3, 300, "第三条"),
      message(1, 100, "第一条"),
      message(2, 200, "第二条"),
    ])
    const history = createProvider(api)
    const result = await history.fetch(group(100), { count: 20 })
    expect(result.text).toBe(
      `<history>\n之前的聊天记录（按时间顺序）：\n` +
        `[${formatTimestamp(100)}] 小明(42): 第一条\n` +
        `[${formatTimestamp(200)}] 小明(42): 第二条\n` +
        `[${formatTimestamp(300)}] 小明(42): 第三条\n` +
        `</history>`,
    )
  })

  it("排除本次运行已经实时处理过的消息", async () => {
    const api = createApi(() => ({
      messages: [message(1, 100, "第一条"), message(2, 200, "第二条")],
    }))
    const history = createProvider(api)
    const result = await history.fetch(group(100), {
      count: 20,
      exclude: new Set(["2"]),
    })
    expect(result.text).toContain("第一条")
    expect(result.text).not.toContain("第二条")
  })

  it("命中上次位置时只补它之后的消息", async () => {
    const api = createApi(() => ({
      messages: [message(1, 100, "旧"), message(2, 200, "离线一"), message(3, 300, "离线二")],
    }))
    const history = createProvider(api)
    const result = await history.fetch(group(100), {
      count: 20,
      since: { id: "1", time: 100 },
    })
    expect(result.text).toContain("离线一")
    expect(result.text).toContain("离线二")
    expect(result.text).not.toContain("旧")
  })

  it("补增量时往更早的方向翻页", async () => {
    const pages: unknown[] = []
    const api = createApi((params) => {
      pages.push(params)
      // 第一页是最新的一条，往前翻一页才拿到更早的消息。
      if (pages.length === 1) return { messages: [message(3, 300, "离线二")] }
      return { messages: [message(1, 100, "旧"), message(2, 200, "离线一")] }
    })
    const history = createProvider(api)
    const result = await history.fetch(group(100), {
      count: 20,
      since: { id: "1", time: 100 },
    })
    expect(pages[0]).toEqual({
      group_id: 100,
      message_seq: "0",
      count: 20,
      reverse_order: true,
    })
    // 游标取页内最旧一条的 message_id，继续往更早翻。
    expect(pages[1]).toEqual({
      group_id: 100,
      message_seq: "3",
      count: 20,
      reverse_order: true,
    })
    expect(result.text).toContain("离线一")
    expect(result.text).toContain("离线二")
    expect(result.text).not.toContain("旧")
  })

  it("位置消息已被清理时按时间切分", async () => {
    const api = createApi(() => ({
      messages: [message(2, 200, "已看过"), message(3, 300, "新的")],
    }))
    const history = createProvider(api)
    const result = await history.fetch(group(100), {
      count: 20,
      since: { id: "1", time: 200 },
    })
    expect(result.text).toContain("新的")
    expect(result.text).not.toContain("已看过")
  })

  it("最多只保留最近 count 条", async () => {
    const api = createApi(() => ({
      messages: [message(1, 100, "一"), message(2, 200, "二"), message(3, 300, "三")],
    }))
    const history = createProvider(api)
    const result = await history.fetch(group(100), { count: 2 })
    expect(result.text).toContain("二")
    expect(result.text).toContain("三")
    expect(result.text).not.toContain("一")
  })

  it("count 为 0 时不请求接口", async () => {
    const api = createApi(() => ({ messages: [message(1, 100, "第一条")] }))
    const history = createProvider(api)
    const result = await history.fetch(group(100), { count: 0 })
    expect(result).toEqual({ text: "", files: [] })
    expect(api.getGroupMsgHistory).not.toHaveBeenCalled()
  })

  it("接口抛错时返回空结果", async () => {
    const api = createApi(() => {
      throw new Error("消息不存在")
    })
    const history = createProvider(api)
    const result = await history.fetch(group(100), { count: 20 })
    expect(result).toEqual({ text: "", files: [] })
  })

  it("发送者名优先群名片，其次昵称，最后 QQ 号", async () => {
    const api = createApi(() => ({
      messages: [
        message(1, 100, "甲", { sender: { user_id: 1, nickname: "昵称甲", card: "名片甲" } }),
        message(2, 200, "乙", { sender: { user_id: 2, nickname: "昵称乙" } }),
        message(3, 300, "丙", { sender: undefined }),
      ],
    }))
    const history = createProvider(api)
    const result = await history.fetch(group(100), { count: 20 })
    expect(result.text).toContain("名片甲(1): 甲")
    expect(result.text).toContain("昵称乙(2): 乙")
    expect(result.text).toContain("42(42): 丙")
  })
})
