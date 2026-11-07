import { describe, expect, it } from "vitest"
import { modelSendScope, pluginSendScope, SendRateLimiter } from "../src/rate-limit"
import type { RateLimitConfig } from "../src/config"

const group = { kind: "group", id: 100 } as const
const otherGroup = { kind: "group", id: 200 } as const

/** 可控的时钟：等待时时间同步前进，测试不依赖真实延时。 */
function createClock() {
  let now = 1_000_000
  const sleeps: number[] = []
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      now += ms
    },
    advance: (ms: number) => {
      now += ms
    },
    sleeps,
  }
}

function createLimiter(config: Partial<RateLimitConfig> = {}) {
  const clock = createClock()
  const limiter = new SendRateLimiter(
    { maxPerMinute: 8, maxPerHour: 60, minGapMs: 0, ...config },
    { now: clock.now, sleep: clock.sleep },
  )
  return { limiter, clock }
}

describe("SendRateLimiter", () => {
  it("放行上限之内的发送", async () => {
    const { limiter } = createLimiter({ maxPerMinute: 2 })
    expect((await limiter.acquire("group:100")).allowed).toBe(true)
    expect((await limiter.acquire("group:100")).allowed).toBe(true)
  })

  it("超过每分钟上限时拒绝发送", async () => {
    const { limiter } = createLimiter({ maxPerMinute: 2 })
    await limiter.acquire("group:100")
    await limiter.acquire("group:100")
    const verdict = await limiter.acquire("group:100")
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain("本分钟")
  })

  it("超过每小时上限时拒绝发送", async () => {
    const { limiter, clock } = createLimiter({ maxPerMinute: 0, maxPerHour: 2 })
    await limiter.acquire("group:100")
    clock.advance(61_000)
    await limiter.acquire("group:100")
    const verdict = await limiter.acquire("group:100")
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain("本小时")
  })

  it("窗口滑过之后重新放行", async () => {
    const { limiter, clock } = createLimiter({ maxPerMinute: 1 })
    await limiter.acquire("group:100")
    expect((await limiter.acquire("group:100")).allowed).toBe(false)
    clock.advance(61_000)
    expect((await limiter.acquire("group:100")).allowed).toBe(true)
  })

  it("0 表示不限制", async () => {
    const { limiter } = createLimiter({ maxPerMinute: 0, maxPerHour: 0 })
    for (let index = 0; index < 50; index += 1) {
      expect((await limiter.acquire("group:100")).allowed).toBe(true)
    }
  })

  it("两次发送之间至少间隔 minGapMs", async () => {
    const { limiter, clock } = createLimiter({ minGapMs: 1500 })
    await limiter.acquire("group:100")
    clock.advance(200)
    await limiter.acquire("group:100")
    expect(clock.sleeps).toEqual([1300])
  })

  it("同一次操作拆出的多段之间不再等待", async () => {
    const { limiter, clock } = createLimiter({ minGapMs: 1500 })
    await limiter.acquire("group:100", "op-1")
    await limiter.acquire("group:100", "op-1")
    await limiter.acquire("group:100", "op-1")
    expect(clock.sleeps).toEqual([])
  })

  it("不同操作之间照样等待", async () => {
    const { limiter, clock } = createLimiter({ minGapMs: 1500 })
    await limiter.acquire("group:100", "op-1")
    await limiter.acquire("group:100", "op-2")
    expect(clock.sleeps).toEqual([1500])
  })

  it("每个目标单独计数", async () => {
    const { limiter } = createLimiter({ maxPerMinute: 1 })
    expect((await limiter.acquire("group:100")).allowed).toBe(true)
    expect((await limiter.acquire("group:200")).allowed).toBe(true)
    expect((await limiter.acquire("group:100")).allowed).toBe(false)
  })

  it("被拒绝的发送不计入额度", async () => {
    const { limiter, clock } = createLimiter({ maxPerMinute: 1 })
    await limiter.acquire("group:100")
    expect((await limiter.acquire("group:100")).allowed).toBe(false)
    clock.advance(61_000)
    expect((await limiter.acquire("group:100")).allowed).toBe(true)
  })

  it("节奏控制不会拒绝发送", async () => {
    const { limiter } = createLimiter({ maxPerMinute: 1 })
    await limiter.acquire("group:100")
    await expect(limiter.pace("group:100")).resolves.toBeUndefined()
  })

  it("插件自己发的消息不占用模型回复的额度", async () => {
    const { limiter } = createLimiter({ maxPerMinute: 1 })
    expect((await limiter.acquire(modelSendScope(group))).allowed).toBe(true)
    expect((await limiter.acquire(pluginSendScope(group))).allowed).toBe(true)
    expect((await limiter.acquire(modelSendScope(group))).allowed).toBe(false)
  })

  it("模型与插件的出站计数按目标分开", () => {
    expect(modelSendScope(group)).toBe("group:100")
    expect(pluginSendScope(group)).not.toBe(modelSendScope(group))
    expect(modelSendScope(otherGroup)).not.toBe(modelSendScope(group))
  })
})
