import { describe, expect, it, vi } from "vitest"
import type { GroupMessageEvent, MessageSegment, OneBotApi } from "@naplink/naplink"
import {
  limitFiles,
  mentionsUser,
  MAX_PROMPT_IMAGES,
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

  it("accepts a message that only mentions the bot", () => {
    expect(shouldProcess([{ type: "at", data: { qq: "999" } }], "999")).toBe(true)
  })

  it("accepts a reply without text", () => {
    expect(shouldProcess([{ type: "reply", data: { id: "5" } }])).toBe(true)
  })
})

describe("mentionsUser", () => {
  it("detects an at segment for the given user", () => {
    expect(mentionsUser([{ type: "at", data: { qq: "999" } }], "999")).toBe(true)
  })

  it("detects an at segment whose qq id is a number", () => {
    expect(mentionsUser([{ type: "at", data: { qq: 999 as unknown as string } }], "999")).toBe(true)
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

  it("caches names per group", async () => {
    const api = makeApi()
    const renderCtx = { ...ctx(api), names: new Map() }
    await resolveUserName(renderCtx, "200")
    await resolveUserName(renderCtx, "200")
    expect(api.getGroupMemberInfo).toHaveBeenCalledTimes(1)
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

  it("sniffs the mime type when the content type is not an image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
            headers: { "content-type": "application/octet-stream" },
          }),
      ),
    )
    try {
      const url = await toInlineImage("https://example.com/a.jpg", logger)
      expect(url).toMatch(/^data:image\/jpeg;base64,/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("skips images larger than the limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(1024), {
            headers: { "content-type": "image/png", "content-length": String(64 * 1024 * 1024) },
          }),
      ),
    )
    try {
      expect(await toInlineImage("https://example.com/big.png", logger)).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("stops reading an oversized body without a content length", async () => {
    const chunk = new Uint8Array(1024 * 1024)
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (let index = 0; index < 8; index += 1) controller.enqueue(chunk)
                controller.close()
              },
            }),
            { headers: { "content-type": "image/png" } },
          ),
      ),
    )
    try {
      expect(await toInlineImage("https://example.com/big.png", logger)).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("limitFiles", () => {
  it("keeps at most the allowed number of images", () => {
    const files = Array.from({ length: MAX_PROMPT_IMAGES + 4 }, (_, index) => ({
      uri: `data:image/png;base64,${"A".repeat(16)}`,
      name: `image-${index}.png`,
    }))
    expect(limitFiles(files)).toHaveLength(MAX_PROMPT_IMAGES)
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

  it("keeps forward nodes without a sender", async () => {
    const api = makeApi({
      getForwardMessage: vi.fn(async () => ({
        messages: [{ message: [{ type: "text", data: { text: "匿名内容" } }] }],
      })),
    })
    const rendered = await renderMessage(ctx(api), makeEvent([forwardSegment("9")]))
    expect(rendered.text).toContain("未知用户：匿名内容")
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

  it("inlines a remote image using the declared content type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
            headers: { "content-type": "image/jpeg" },
          }),
      ),
    )
    try {
      const rendered = await renderMessage(
        ctx(makeApi()),
        makeEvent([{ type: "image", data: { file: "a.jpg", url: "https://example.com/a.jpg" } }]),
      )
      expect(rendered.files).toHaveLength(1)
      expect(rendered.files[0]?.uri).toMatch(/^data:image\/jpeg;base64,/)
      expect(rendered.files[0]?.name).toBe("qq-image-1.jpg")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("names the attachment after the sniffed mime type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
            headers: { "content-type": "application/octet-stream" },
          }),
      ),
    )
    try {
      const rendered = await renderMessage(
        ctx(makeApi()),
        makeEvent([{ type: "image", data: { file: "a.jpg", url: "https://example.com/a.jpg" } }]),
      )
      expect(rendered.files[0]?.name).toBe("qq-image-1.jpg")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("caps the number of inlined images per message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
            headers: { "content-type": "image/jpeg" },
          }),
      ),
    )
    try {
      const message = Array.from({ length: MAX_PROMPT_IMAGES + 5 }, (_, index) => ({
        type: "image" as const,
        data: { file: `a${index}.jpg`, url: `https://example.com/a${index}.jpg` },
      }))
      const rendered = await renderMessage(ctx(makeApi()), makeEvent(message))
      expect(rendered.files).toHaveLength(MAX_PROMPT_IMAGES)
      expect(rendered.text.match(/\[图片\]/g)).toHaveLength(MAX_PROMPT_IMAGES + 5)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
