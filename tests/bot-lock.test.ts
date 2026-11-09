import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import { acquireBotLock, botLockPath } from "../src/bot-lock"

const lockPath = botLockPath()
const ownerPath = `${lockPath}.owner`
/** 一个不可能存在的 PID，用来模拟已经退出的持锁进程。 */
const deadPid = 2_000_000_000

afterEach(() => {
  rmSync(lockPath, { recursive: true, force: true })
  rmSync(ownerPath, { force: true })
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
    expect(existsSync(ownerPath)).toBe(false)
  })

  it("takes over immediately when the owner process is gone", async () => {
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(ownerPath, JSON.stringify({ pid: deadPid }), "utf8")
    // 刚建立时先不抢，这里是已经持有一段时间的锁。
    const past = new Date(Date.now() - 60_000)
    utimesSync(lockPath, past, past)

    const lock = await acquireBotLock()
    expect(lock).toBeDefined()
    await lock?.release()
  })

  it("does not take over a lock that was just created", async () => {
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(ownerPath, JSON.stringify({ pid: deadPid }), "utf8")

    // 留出持锁方写归属文件的时间，避免抢到刚建立、还没写完的锁。
    expect(await acquireBotLock()).toBeUndefined()
  })

  it("does not take over a lock held by a live process", async () => {
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(ownerPath, JSON.stringify({ pid: process.pid }), "utf8")
    const past = new Date(Date.now() - 60_000)
    utimesSync(lockPath, past, past)

    expect(await acquireBotLock()).toBeUndefined()
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
