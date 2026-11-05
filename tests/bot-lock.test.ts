import { existsSync, mkdirSync, rmSync, utimesSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { acquireBotLock, botIdentity, botLockName, botLockPath } from "../src/bot-lock"

let counter = 0
/** 每个用例用独立身份，避免上次运行残留的锁影响结果。 */
const uniqueIdentity = (name: string) => `ws://${name}-${process.pid}-${counter++}`

describe("bot lock", () => {
  it("lets only one holder consume the same bot", async () => {
    const identity = uniqueIdentity("bot-a")
    try {
      const first = await acquireBotLock(identity)
      expect(first).toBeDefined()
      expect(await acquireBotLock(identity)).toBeUndefined()
      await first?.release()
      const third = await acquireBotLock(identity)
      expect(third).toBeDefined()
      await third?.release()
    } finally {
      rmSync(botLockPath(identity), { recursive: true, force: true })
    }
  })

  it("does not block a different bot", async () => {
    const first = uniqueIdentity("bot-b")
    const second = uniqueIdentity("bot-c")
    try {
      const firstLock = await acquireBotLock(first)
      const secondLock = await acquireBotLock(second)
      expect(firstLock).toBeDefined()
      expect(secondLock).toBeDefined()
      await firstLock?.release()
      await secondLock?.release()
    } finally {
      rmSync(botLockPath(first), { recursive: true, force: true })
      rmSync(botLockPath(second), { recursive: true, force: true })
    }
  })

  it("derives the identity from the napcat endpoint and token", () => {
    expect(botIdentity({ url: "ws://bot-a" })).toBe(
      botIdentity({ url: "ws://bot-a", token: undefined }),
    )
    expect(botIdentity({ url: "ws://bot-a", token: "t1" })).not.toBe(
      botIdentity({ url: "ws://bot-a", token: "t2" }),
    )
    expect(botIdentity({ url: "ws://bot-a", token: "t1" })).not.toBe(
      botIdentity({ url: "ws://bot-b" }),
    )
  })

  it("derives a stable short lock name", () => {
    expect(botLockName("ws://bot-a")).toBe(botLockName("ws://bot-a"))
    expect(botLockName("ws://bot-a")).not.toBe(botLockName("ws://bot-b"))
    expect(botLockName("ws://bot-a")).toMatch(/^[0-9a-f]{16}$/)
  })

  it("derives a lock directory per identity", () => {
    expect(botLockPath("ws://bot-a")).toBe(botLockPath("ws://bot-a"))
    expect(botLockPath("ws://bot-a")).not.toBe(botLockPath("ws://bot-b"))
    expect(botLockPath("ws://bot-a")).toMatch(/opencode-qq-bot-[0-9a-f]{16}\.lock$/)
  })

  it("keeps the lock directory while the lock is held", async () => {
    const identity = uniqueIdentity("hold-bot")
    try {
      const lock = await acquireBotLock(identity)
      expect(existsSync(botLockPath(identity))).toBe(true)
      await lock?.release()
      expect(existsSync(botLockPath(identity))).toBe(false)
    } finally {
      rmSync(botLockPath(identity), { recursive: true, force: true })
    }
  })

  it("takes over a lock left behind by a crashed process", async () => {
    const identity = uniqueIdentity("stale-bot")
    const lockPath = botLockPath(identity)
    mkdirSync(lockPath, { recursive: true })
    // 进程崩溃后残留的锁：修改时间已经过期。
    const past = new Date(Date.now() - 120_000)
    utimesSync(lockPath, past, past)
    try {
      const lock = await acquireBotLock(identity)
      expect(lock).toBeDefined()
      await lock?.release()
    } finally {
      rmSync(lockPath, { recursive: true, force: true })
    }
  })

  it("does not take over a lock that is still fresh", async () => {
    const identity = uniqueIdentity("fresh-bot")
    const lockPath = botLockPath(identity)
    mkdirSync(lockPath, { recursive: true })
    try {
      expect(await acquireBotLock(identity)).toBeUndefined()
    } finally {
      rmSync(lockPath, { recursive: true, force: true })
    }
  })

  it("releases cleanly when the lock directory is already gone", async () => {
    const identity = uniqueIdentity("missing-bot")
    const lock = await acquireBotLock(identity)
    expect(lock).toBeDefined()
    rmSync(botLockPath(identity), { recursive: true, force: true })
    await expect(lock?.release()).resolves.toBeUndefined()
  })
})
