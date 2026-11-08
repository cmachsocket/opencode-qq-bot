import { describe, expect, it, vi } from "vitest"
import type { MessageSegment, OneBotApi } from "@naplink/naplink"
import { hydrateSegment, pickRemoteUrl } from "../src/naplink/client"
import type { Logger } from "../src/logger"

const LOCAL_PATH = "/root/.config/QQ/nt_qq_abc/nt_data/Pic/2026-11/Ori/9a863feb.jpg"
const CDN_URL = "https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc"

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function makeApi(overrides: Record<string, unknown> = {}): OneBotApi {
  return {
    getFile: vi.fn(async () => ({ file: LOCAL_PATH, url: CDN_URL })),
    getImage: vi.fn(async () => ({ file: LOCAL_PATH, url: CDN_URL })),
    getRecord: vi.fn(async () => ({ file: LOCAL_PATH, url: "https://cdn.example.com/a.mp3" })),
    ...overrides,
  } as unknown as OneBotApi
}

function segmentData(segment: MessageSegment): { url?: unknown; file?: unknown } {
  return segment.data as { url?: unknown; file?: unknown }
}

function imageSegment(data: Record<string, unknown>): MessageSegment {
  return { type: "image", data } as unknown as MessageSegment
}

describe("pickRemoteUrl", () => {
  it("returns the first http(s) url", () => {
    expect(pickRemoteUrl(LOCAL_PATH, CDN_URL)).toBe(CDN_URL)
    expect(pickRemoteUrl("file:///tmp/a.jpg", "http://example.com/a.jpg")).toBe(
      "http://example.com/a.jpg",
    )
  })

  it("ignores local paths, base64 and non-strings", () => {
    expect(pickRemoteUrl(LOCAL_PATH, "base64://abcd", undefined, 42)).toBeUndefined()
  })
})

describe("hydrateSegment", () => {
  it("keeps an existing remote url and avoids API calls", async () => {
    const api = makeApi()
    const segment = imageSegment({ file: LOCAL_PATH, url: CDN_URL })
    await hydrateSegment(api, segment, makeLogger())
    expect(api.getFile).not.toHaveBeenCalled()
    expect(segmentData(segment).url).toBe(CDN_URL)
  })

  it("prefers the remote url over the local file returned by get_file", async () => {
    const api = makeApi()
    const segment = imageSegment({ file: "a.jpg" })
    await hydrateSegment(api, segment, makeLogger())
    expect(api.getFile).toHaveBeenCalledWith("a.jpg")
    expect(segmentData(segment).url).toBe(CDN_URL)
    // 本地文件名保持不变，便于文本里展示。
    expect(segmentData(segment).file).toBe("a.jpg")
  })

  it("accepts a remote url returned in the file field", async () => {
    const api = makeApi({ getFile: vi.fn(async () => ({ file: CDN_URL })) })
    const segment = imageSegment({ file: "a.jpg" })
    await hydrateSegment(api, segment, makeLogger())
    expect(segmentData(segment).url).toBe(CDN_URL)
  })

  it("falls back to get_image when get_file only returns a local path", async () => {
    const api = makeApi({ getFile: vi.fn(async () => ({ file: LOCAL_PATH })) })
    const segment = imageSegment({ file: "a.jpg" })
    await hydrateSegment(api, segment, makeLogger())
    expect(api.getImage).toHaveBeenCalledWith("a.jpg")
    expect(segmentData(segment).url).toBe(CDN_URL)
  })

  it("falls back to get_record for audio segments", async () => {
    const api = makeApi({ getFile: vi.fn(async () => ({ file: LOCAL_PATH })) })
    const segment = { type: "record", data: { file: "a.amr" } } as unknown as MessageSegment
    await hydrateSegment(api, segment, makeLogger())
    expect(api.getRecord).toHaveBeenCalledWith("a.amr", "mp3")
    expect(segmentData(segment).url).toBe("https://cdn.example.com/a.mp3")
  })

  it("skips file references that are already usable", async () => {
    const api = makeApi()
    const segment = imageSegment({ file: "file:///tmp/a.jpg" })
    await hydrateSegment(api, segment, makeLogger())
    expect(api.getFile).not.toHaveBeenCalled()
    expect(segmentData(segment).url).toBeUndefined()
  })

  it("swallows API failures and logs them", async () => {
    const logger = makeLogger()
    const api = makeApi({
      getFile: vi.fn(async () => {
        throw new Error("boom")
      }),
    })
    const segment = imageSegment({ file: "a.jpg" })
    await expect(hydrateSegment(api, segment, logger)).resolves.toBeUndefined()
    expect(logger.debug).toHaveBeenCalled()
    expect(segmentData(segment).url).toBeUndefined()
  })

  it("ignores non-media segments", async () => {
    const api = makeApi()
    const segment = { type: "text", data: { text: "hi" } } as MessageSegment
    await hydrateSegment(api, segment, makeLogger())
    expect(api.getFile).not.toHaveBeenCalled()
  })
})
