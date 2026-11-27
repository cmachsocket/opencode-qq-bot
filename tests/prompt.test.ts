import { describe, expect, it } from "vitest"
import { buildSystemPrompt, currentTimeText } from "../src/session/prompt"

describe("buildSystemPrompt", () => {
  it("keeps the guidelines even when the soul file is missing", () => {
    const prompt = buildSystemPrompt("")
    expect(prompt).toContain("qq_send_message")
    expect(prompt).not.toContain("\n\n")
  })

  it("prepends the soul text", () => {
    const prompt = buildSystemPrompt("你是白羽桃")
    expect(prompt.startsWith("你是白羽桃")).toBe(true)
  })
})

describe("currentTimeText", () => {
  it("formats the time as YYYY-MM-DD HH:mm:ss", () => {
    const text = currentTimeText("Asia/Shanghai", new Date("2026-01-01T19:04:05Z"))
    expect(text).toBe("2026-01-02 03:04:05")
  })

  it("按指定时区换算", () => {
    expect(currentTimeText("UTC", new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02 03:04:05")
  })
})
