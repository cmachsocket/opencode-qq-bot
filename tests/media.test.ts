import { afterAll, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMediaStore, isPrivateHost } from "../src/naplink/media"
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

describe("isPrivateHost", () => {
  it("rejects loopback and private addresses", () => {
    for (const host of ["localhost", "127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "::1"]) {
      expect(isPrivateHost(host)).toBe(true)
    }
  })

  it("accepts public hostnames", () => {
    expect(isPrivateHost("example.com")).toBe(false)
    expect(isPrivateHost("8.8.8.8")).toBe(false)
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
