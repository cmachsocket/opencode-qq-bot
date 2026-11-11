import { describe, expect, it } from "vitest"
import { softTruncate, TRUNCATION_MARKER } from "../src/text"

describe("softTruncate", () => {
  it("没超长时原样返回", () => {
    expect(softTruncate("短句。", 20)).toBe("短句。")
    expect(softTruncate("刚好二十个字刚好二十个字刚好二十个字", 20)).toBe(
      "刚好二十个字刚好二十个字刚好二十个字",
    )
  })

  it("在段落边界收尾并标注截断", () => {
    const text = `${"第一段。".repeat(10)}\n\n${"第二段。".repeat(10)}`
    const result = softTruncate(text, 40)
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(result).toContain("第一段。")
    expect(result).not.toContain("第二段。")
    expect(Array.from(result).length).toBeLessThanOrEqual(40)
  })

  it("没有段落时退到句子边界", () => {
    const text = `${"第一句。".repeat(10)}${"第二句。".repeat(10)}`
    const result = softTruncate(text, 30)
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(result).toContain("第一句。")
    expect(result).not.toContain("第二句。")
  })

  it("整段没有标点时按码点切，标记照常加上", () => {
    const result = softTruncate("一".repeat(100), 20)
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(Array.from(result).length).toBeLessThanOrEqual(20)
    expect(result).toContain("一".repeat(10))
  })

  it("不切开半个 emoji", () => {
    const result = softTruncate("😀".repeat(20), 12)
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(result).not.toContain("�")
    const head = result.slice(0, -Array.from(TRUNCATION_MARKER).length)
    expect(Array.from(head).every((c) => c === "😀")).toBe(true)
  })

  it("上限比标记还小时只能按码点切", () => {
    expect(softTruncate("abcdef", 3)).toBe("abc")
  })

  it("截掉的部分不会挤占标记的位置", () => {
    const result = softTruncate("内容。".repeat(50), 30)
    expect(Array.from(result).length).toBeLessThanOrEqual(30)
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true)
  })
})
