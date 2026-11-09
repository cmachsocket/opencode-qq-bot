import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runUnload } from "../src/unload"

/** 造一个假的锁目录，用来验证释放步骤真的把锁删掉。 */
function fakeLock(): { path: string; release: () => Promise<void> } {
  const root = mkdtempSync(join(tmpdir(), "qq-bot-unload-"))
  const path = join(root, "opencode-qq-bot.lock")
  mkdirSync(path)
  return {
    path,
    release: async () => {
      rmSync(path, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe("runUnload", () => {
  it("按顺序执行全部步骤", async () => {
    const order: string[] = []
    await runUnload(
      [
        {
          name: "停止保活心跳",
          run: () => {
            order.push("停止保活心跳")
          },
        },
        {
          name: "释放机器人连接锁",
          run: async () => {
            order.push("释放机器人连接锁")
          },
        },
      ],
      { error: () => {} },
    )
    expect(order).toEqual(["停止保活心跳", "释放机器人连接锁"])
  })

  it("某一步失败时仍然执行后面的步骤", async () => {
    const ran: string[] = []
    const errors: string[] = []
    await runUnload(
      [
        {
          name: "断开 NapCat",
          run: () => {
            throw new Error("连接失败")
          },
        },
        {
          name: "释放机器人连接锁",
          run: () => {
            ran.push("释放机器人连接锁")
          },
        },
      ],
      {
        error: (message) => {
          errors.push(message)
        },
      },
    )
    expect(ran).toEqual(["释放机器人连接锁"])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("断开 NapCat")
  })

  it("异步步骤失败同样不阻断后面的步骤", async () => {
    const ran: string[] = []
    await runUnload(
      [
        {
          name: "注销工具",
          run: async () => {
            throw new Error("上游异常")
          },
        },
        {
          name: "释放机器人连接锁",
          run: () => {
            ran.push("释放机器人连接锁")
          },
        },
      ],
      { error: () => {} },
    )
    expect(ran).toEqual(["释放机器人连接锁"])
  })

  it("前面的步骤失败时机器级锁仍然被释放", async () => {
    const lock = fakeLock()
    expect(existsSync(lock.path)).toBe(true)
    await runUnload(
      [
        {
          name: "注销工具",
          run: async () => {
            throw new Error("上游异常")
          },
        },
        { name: "释放机器人连接锁", run: () => lock.release() },
      ],
      { error: () => {} },
    )
    expect(existsSync(lock.path)).toBe(false)
  })
})
