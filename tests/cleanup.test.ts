import { describe, expect, it, vi } from "vitest"
import { Cleanup, CleanupOrder } from "../src/cleanup"

const logger = { error: vi.fn() }

describe("Cleanup", () => {
  it("runs the steps in the given order", async () => {
    const cleanup = new Cleanup()
    const order: string[] = []
    cleanup.add("后", () => void order.push("后"), CleanupOrder.napcat)
    cleanup.add("前", () => void order.push("前"), CleanupOrder.handover)

    await cleanup.run(logger)

    expect(order).toEqual(["前", "后"])
    expect(cleanup.done).toBe(true)
  })

  it("keeps running the remaining steps when one fails", async () => {
    const cleanup = new Cleanup()
    const ran: string[] = []
    cleanup.add(
      "会失败",
      () => {
        throw new Error("boom")
      },
      10,
    )
    cleanup.add("会执行", () => void ran.push("会执行"), 20)

    await cleanup.run(logger)

    expect(ran).toEqual(["会执行"])
    expect(logger.error).toHaveBeenCalledWith("卸载步骤失败：会失败", expect.any(Error))
  })

  it("runs the steps only once", async () => {
    const cleanup = new Cleanup()
    const step = vi.fn()
    cleanup.add("只跑一次", step, 10)

    await cleanup.run(logger)
    await cleanup.run(logger)

    expect(step).toHaveBeenCalledTimes(1)
  })

  it("releases a step registered after the cleanup already ran", async () => {
    const cleanup = new Cleanup()
    await cleanup.run(logger)

    const late = vi.fn()
    cleanup.add("迟到的步骤", late, 10)
    await Promise.resolve()

    expect(late).toHaveBeenCalledTimes(1)
  })
})
