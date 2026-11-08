import { afterAll, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMediaStore } from "../src/naplink/media"
import type { Logger } from "../src/logger"

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const root = await mkdtemp(join(tmpdir(), "qq-media-test-"))

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("MediaStore 出站下载", () => {
  it("拒绝下载指向回环地址的图片", async () => {
    const hits: string[] = []
    const server = http.createServer((request, response) => {
      hits.push(request.url ?? "")
      response.writeHead(200, { "content-type": "image/png" })
      response.end(Buffer.from(PNG))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port
    try {
      const store = await createMediaStore(logger, { root, ttlMs: 0 })
      const stored = await store.storeImage(`http://127.0.0.1:${port}/image.png`)
      expect(stored).toBeUndefined()
      expect(hits).toEqual([])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe("MediaStore.cleanup", () => {
  it("removes files older than the ttl", async () => {
    const store = await createMediaStore(logger, { root, ttlMs: 0 })
    const stored = await store.storeImage(`base64://${Buffer.from(PNG).toString("base64")}`)
    expect(stored).toBeDefined()
    const removed = await store.cleanup(Date.now() + 1000)
    expect(removed).toBe(1)
  })
})

describe("MediaStore HTTP 图片", () => {
  it("按魔数判定而不是信任声明类型", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qq-media-http-"))
    try {
      const svg = await createMediaStore(logger, {
        root: dir,
        ttlMs: 0,
        fetcher: async () => ({ status: 200, contentType: "image/svg+xml", bytes: PNG }),
      })
      expect((await svg.storeImage("https://example.com/a.svg"))?.ext).toBe("png")

      const fake = await createMediaStore(logger, {
        root: dir,
        ttlMs: 0,
        fetcher: async () => ({
          status: 200,
          contentType: "image/png",
          bytes: Buffer.from("not an image"),
        }),
      })
      expect(await fake.storeImage("https://example.com/b.png")).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("MediaStore data URL", () => {
  it("trusts the magic bytes instead of the declared type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qq-media-data-"))
    try {
      const store = await createMediaStore(logger, { root: dir, ttlMs: 0 })
      const payload = Buffer.from(PNG).toString("base64")
      const stored = await store.storeImage(`data:image/svg+xml;base64,${payload}`)
      expect(stored?.ext).toBe("png")
      const invalid = await store.storeImage(
        `data:image/png;base64,${Buffer.from("not an image").toString("base64")}`,
      )
      expect(invalid).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
