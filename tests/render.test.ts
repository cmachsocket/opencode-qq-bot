import { describe, expect, it, vi } from "vitest"
import type { GroupMessageEvent, MessageSegment, OneBotApi } from "@naplink/naplink"
import {
  mentionsUser,
  renderMessage,
  resolveUserName,
  shouldProcess,
  toInlineImage,
} from "../src/naplink/render"
import type { Logger } from "../src/logger"

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** NapCat 的 forward 段没有官方类型定义，测试里按运行时结构构造。 */
function forwardSegment(id: string): MessageSegment {
  return { type: "forward", data: { id } } as unknown as MessageSegment
}

function makeEvent(
  message: MessageSegment[],
  extra: Partial<GroupMessageEvent> = {},
): GroupMessageEvent {
  return {
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    group_id: 100,
    message_id: 1,
    user_id: 200,
    raw_message: "",
    font: 0,
    time: 0,
    self_id: 999,
    sender: { user_id: 200 },
    message,
    ...extra,
  } as GroupMessageEvent
}

function makeApi(overrides: Partial<OneBotApi> = {}): OneBotApi {
  return {
    getGroupMemberInfo: vi.fn(async () => ({ card: "名片", nickname: "昵称" })),
    getMessage: vi.fn(async () => ({
      sender: { user_id: 200 },
      message: [{ type: "text", data: { text: "被引用的内容" } }],
    })),
    getForwardMessage: vi.fn(async () => ({
      messages: [
        {
          sender: { user_id: 1, nickname: "甲", card: "甲群名片" },
          message: [{ type: "text", data: { text: "转发内容" } }],
        },
      ],
    })),
    fetchPttText: vi.fn(async () => ({ text: "语音转写" })),
    ...overrides,
  } as unknown as OneBotApi
}

const ctx = (api: OneBotApi) => ({ api, groupId: 100, logger })

describe("shouldProcess", () => {
  it("accepts text messages", () => {
    expect(shouldProcess([{ type: "text", data: { text: "你好" } }])).toBe(true)
  })

  it("rejects empty text", () => {
    expect(shouldProcess([{ type: "text", data: { text: "  " } }])).toBe(false)
  })

  it("accepts images, records and forwards", () => {
    expect(shouldProcess([{ type: "image", data: { file: "a.jpg" } }])).toBe(true)
    expect(shouldProcess([{ type: "record", data: { file: "a.amr" } }])).toBe(true)
    expect(shouldProcess([forwardSegment("1")])).toBe(true)
  })

  it("rejects unsupported segments", () => {
    expect(shouldProcess([{ type: "face", data: { id: "1" } }])).toBe(false)
  })
})

describe("mentionsUser", () => {
  it("detects an at segment for the given user", () => {
    expect(mentionsUser([{ type: "at", data: { qq: "999" } }], "999")).toBe(true)
  })

  it("ignores at segments for other users", () => {
    expect(mentionsUser([{ type: "at", data: { qq: "123" } }], "999")).toBe(false)
  })

  it("returns false without a user id", () => {
    expect(mentionsUser([{ type: "at", data: { qq: "999" } }], undefined)).toBe(false)
  })
})

describe("resolveUserName", () => {
  it("prefers the group card", async () => {
    const name = await resolveUserName(ctx(makeApi()), "200")
    expect(name).toBe("名片")
  })

  it("falls back to the nickname", async () => {
    const api = makeApi({ getGroupMemberInfo: vi.fn(async () => ({ nickname: "昵称" })) })
    const name = await resolveUserName(ctx(api), "200")
    expect(name).toBe("昵称")
  })

  it("falls back to a placeholder on failure", async () => {
    const api = makeApi({
      getGroupMemberInfo: vi.fn(async () => {
        throw new Error("boom")
      }),
    })
    const name = await resolveUserName(ctx(api), "200")
    expect(name).toBe("未知用户")
  })
})

describe("toInlineImage", () => {
  it("converts a base64 url into a data url", async () => {
    const url = await toInlineImage("base64://AAAA", logger)
    expect(url).toBe("data:image/png;base64,AAAA")
  })

  it("passes data urls through", async () => {
    const url = await toInlineImage("data:image/jpeg;base64,BBBB", logger)
    expect(url).toBe("data:image/jpeg;base64,BBBB")
  })

  it("ignores unsupported schemes", async () => {
    expect(await toInlineImage("/local/a.jpg", logger)).toBeUndefined()
  })
})

describe("renderMessage", () => {
  it("renders plain text", async () => {
    const rendered = await renderMessage(
      ctx(makeApi()),
      makeEvent([{ type: "text", data: { text: "在吗" } }]),
    )
    expect(rendered.text).toBe("在吗")
    expect(rendered.files).toEqual([])
  })

  it("expands a reply into a quote block", async () => {
    const rendered = await renderMessage(
      ctx(makeApi()),
      makeEvent([
        { type: "reply", data: { id: "5" } },
        { type: "text", data: { text: "现在呢" } },
      ]),
    )
    expect(rendered.text).toContain("<quote>")
    expect(rendered.text).toContain("被引用的内容")
    expect(rendered.text).toContain("</quote>")
    expect(rendered.text).toContain("现在呢")
  })

  it("transcribes a voice message", async () => {
    const rendered = await renderMessage(
      ctx(makeApi()),
      makeEvent([{ type: "record", data: { file: "a.amr" } }]),
    )
    expect(rendered.text).toContain("[语音] 语音转写")
  })

  it("renders a forward message inside a forward block", async () => {
    const rendered = await renderMessage(ctx(makeApi()), makeEvent([forwardSegment("9")]))
    expect(rendered.text).toContain("<forward>")
    expect(rendered.text).toContain("甲群名片：转发内容")
    expect(rendered.text).toContain("</forward>")
  })

  it("replaces an at segment with the user name", async () => {
    const rendered = await renderMessage(
      ctx(makeApi()),
      makeEvent([
        { type: "at", data: { qq: "200" } },
        { type: "text", data: { text: " hi" } },
      ]),
    )
    expect(rendered.text).toContain("@名片")
  })

  it("keeps a placeholder for an image without a reachable url", async () => {
    const rendered = await renderMessage(
      ctx(makeApi()),
      makeEvent([{ type: "image", data: { file: "local.jpg" } }]),
    )
    expect(rendered.text).toContain("[图片]")
    expect(rendered.files).toEqual([])
  })
})
