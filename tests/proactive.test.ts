import { describe, expect, it } from "vitest"
import { proactiveTickProbability } from "../src/session/proactive"

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
