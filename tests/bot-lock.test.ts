import { existsSync, mkdirSync, rmSync, utimesSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import { acquireBotLock, botLockPath } from "../src/bot-lock"

const lockPath = botLockPath()

afterEach(() => {
  rmSync(lockPath, { recursive: true, force: true })
})

describe("bot lock", () => {
  it("uses one lock directory for the whole machine", () => {
    expect(lockPath.endsWith("opencode-qq-bot.lock")).toBe(true)
    expect(botLockPath()).toBe(lockPath)
  })

  it("lets only one holder consume the machine", async () => {
    const first = await acquireBotLock()
    expect(first).toBeDefined()
    expect(await acquireBotLock()).toBeUndefined()
    await first?.release()
    const third = await acquireBotLock()
    expect(third).toBeDefined()
    await third?.release()
  })

  it("keeps the lock directory while the lock is held", async () => {
    const lock = await acquireBotLock()
    expect(lock).toBeDefined()
    expect(existsSync(lockPath)).toBe(true)
    await lock?.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it("takes over a lock left behind by a crashed process", async () => {
    mkdirSync(lockPath, { recursive: true })
    // 进程崩溃后残留的锁：修改时间已经超过过期窗口。
    const past = new Date(Date.now() - 180_000)
    utimesSync(lockPath, past, past)
    const lock = await acquireBotLock()
    expect(lock).toBeDefined()
    await lock?.release()
  })

  it("does not take over a lock that is still fresh", async () => {
    mkdirSync(lockPath, { recursive: true })
    expect(await acquireBotLock()).toBeUndefined()
  })

  it("releases cleanly when the lock directory is already gone", async () => {
    const lock = await acquireBotLock()
    expect(lock).toBeDefined()
    rmSync(lockPath, { recursive: true, force: true })
    await expect(lock?.release()).resolves.toBeUndefined()
  })
})
