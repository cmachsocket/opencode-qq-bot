import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireStateLock } from "../src/state-lock"

/** 临时目录：锁目录建在里面。 */
async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "qq-bot-state-"))
}

describe("共享状态写锁", () => {
  it("同一时间只有一个持有者", async () => {
    const dir = await tempDir()
    const path = join(dir, "state.lock")
    try {
      const first = await acquireStateLock(path)
      expect(first).toBeDefined()
      // 第二个拿不到：共享状态不能被两个实例同时改。
      expect(await acquireStateLock(path)).toBeUndefined()
      await first?.release()
      // 释放之后能再拿到。
      const again = await acquireStateLock(path)
      expect(again).toBeDefined()
      await again?.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("释放后锁目录被清掉", async () => {
    const dir = await tempDir()
    const path = join(dir, "state.lock")
    try {
      const lock = await acquireStateLock(path)
      expect(existsSync(path)).toBe(true)
      await lock?.release()
      expect(existsSync(path)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("锁路径的父目录不存在时报错", async () => {
    const dir = await tempDir()
    try {
      await expect(acquireStateLock(join(dir, "missing", "state.lock"))).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
