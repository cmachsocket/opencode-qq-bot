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
    const text = currentTimeText(new Date(2026, 0, 2, 3, 4, 5))
    expect(text).toBe("2026-01-02 03:04:05")
  })
})
