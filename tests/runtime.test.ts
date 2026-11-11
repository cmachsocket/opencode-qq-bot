import { afterEach, describe, expect, it, vi } from "vitest"
import { startClaimTimer } from "../src/runtime/claim"
import { RuntimeStart } from "../src/runtime/start"

describe("运行时启动", () => {
  it("全部步骤成功才算启动完成", async () => {
    const setup = vi.fn(async () => {})
    const start = new RuntimeStart({
      canStart: () => true,
      setup,
      onFailure: () => {},
    })
    await start.run()
    expect(start.isStarted).toBe(true)
    expect(setup).toHaveBeenCalledTimes(1)
  })

  it("启动失败不算启动完成，并且先释放机器锁", async () => {
    const released: unknown[] = []
    const start = new RuntimeStart({
      canStart: () => true,
      setup: async () => {
        throw new Error("连不上 NapCat")
      },
      onFailure: (error) => {
        released.push(error)
      },
    })
    await expect(start.run()).rejects.toThrow("连不上 NapCat")
    expect(start.isStarted).toBe(false)
    expect(released).toHaveLength(1)
  })

  it("失败之后还能重试", async () => {
    let attempts = 0
    const released: unknown[] = []
    const start = new RuntimeStart({
      canStart: () => true,
      setup: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("第一次失败")
      },
      onFailure: (error) => {
        released.push(error)
      },
    })
    await expect(start.run()).rejects.toThrow("第一次失败")
    await start.run()
    expect(start.isStarted).toBe(true)
    expect(attempts).toBe(2)
    expect(released).toHaveLength(1)
  })

  it("并发调用共享同一次启动", async () => {
    let attempts = 0
    const start = new RuntimeStart({
      canStart: () => true,
      setup: async () => {
        attempts += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
      },
      onFailure: () => {},
    })
    await Promise.all([start.run(), start.run()])
    expect(attempts).toBe(1)
    expect(start.isStarted).toBe(true)
  })

  it("卸载已经开始就不再启动", async () => {
    const setup = vi.fn(async () => {})
    const start = new RuntimeStart({
      canStart: () => false,
      setup,
      onFailure: () => {},
    })
    await start.run()
    expect(setup).not.toHaveBeenCalled()
    expect(start.isStarted).toBe(false)
  })
})

describe("接管重试定时器", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("抢到锁之后搭运行时", async () => {
    vi.useFakeTimers()
    const claimed: number[] = []
    let attempts = 0
    const timer = startClaimTimer({
      intervalMs: 1000,
      shouldTry: () => true,
      claim: async () => {
        attempts += 1
        return attempts > 1
      },
      onClaimed: async () => {
        claimed.push(attempts)
      },
      onError: () => {},
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(claimed).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(claimed).toEqual([2])
    timer.stop()
  })

  it("已经在锁里就不再试", async () => {
    vi.useFakeTimers()
    const claim = vi.fn(async () => true)
    const timer = startClaimTimer({
      intervalMs: 1000,
      shouldTry: () => false,
      claim,
      onClaimed: async () => {},
      onError: () => {},
    })
    await vi.advanceTimersByTimeAsync(3000)
    expect(claim).not.toHaveBeenCalled()
    timer.stop()
  })

  it("出错时走错误处理，不会打崩定时器", async () => {
    vi.useFakeTimers()
    const errors: unknown[] = []
    const timer = startClaimTimer({
      intervalMs: 1000,
      shouldTry: () => true,
      claim: async () => {
        throw new Error("锁目录不可写")
      },
      onClaimed: async () => {},
      onError: (error) => {
        errors.push(error)
      },
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(errors).toHaveLength(2)
    timer.stop()
  })

  it("停掉之后不再触发", async () => {
    vi.useFakeTimers()
    const claim = vi.fn(async () => false)
    const timer = startClaimTimer({
      intervalMs: 1000,
      shouldTry: () => true,
      claim,
      onClaimed: async () => {},
      onError: () => {},
    })
    timer.stop()
    await vi.advanceTimersByTimeAsync(3000)
    expect(claim).not.toHaveBeenCalled()
  })
})
