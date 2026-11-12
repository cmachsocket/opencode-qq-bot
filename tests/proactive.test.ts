import { describe, expect, it } from "vitest"
import { proactiveProbability, proactiveTickProbability } from "../src/session/proactive"

const config = {
  startProbability: 0.1,
  probabilityPerHour: 0.1,
  silenceThresholdSeconds: 3600,
  tickSeconds: 600,
}

describe("proactiveTickProbability", () => {
  it("returns zero before the silence threshold", () => {
    expect(proactiveTickProbability(config, 3000)).toBe(0)
  })

  it("keeps the hourly rate independent of the tick size", () => {
    const oneHour = { ...config, tickSeconds: 3600 }
    const tenMinutes = { ...config, tickSeconds: 600 }
    expect(proactiveTickProbability(oneHour, 7200)).toBeCloseTo(0.2)
    expect(proactiveTickProbability(tenMinutes, 7200)).toBeCloseTo(1 - Math.pow(0.8, 1 / 6))
  })

  it("caps the target probability at one", () => {
    expect(proactiveTickProbability(config, 3600 * 100)).toBe(1)
  })
})

describe("proactiveProbability", () => {
  it("没有覆盖时按全局公式算", () => {
    expect(proactiveProbability({}, config, 7200)).toBeCloseTo(
      proactiveTickProbability(config, 7200),
    )
  })

  it("聊天写了概率就用聊天自己的", () => {
    expect(proactiveProbability({ "proactive.startProbability": 0.3 }, config, 7200)).toBe(0.3)
    expect(proactiveProbability({ "proactive.startProbability": 0 }, config, 7200)).toBe(0)
  })

  it("沉默没到阈值时一律不主动开口", () => {
    expect(proactiveProbability({ "proactive.startProbability": 0.3 }, config, 3000)).toBe(0)
  })
})
