import { describe, expect, it } from "vitest"
import {
  dropTables,
  MAX_MESSAGE_CHARS,
  prepareOutbound,
  splitGraphemes,
  splitMessage,
  toPlainText,
} from "../src/outbound"

describe("toPlainText", () => {
  it("strips headings and emphasis", () => {
    expect(toPlainText("# 标题\n\n**粗体**和*斜体*")).toBe("标题\n\n粗体和斜体")
  })

  it("drops list leaders but keeps the items", () => {
    expect(toPlainText("- 第一项\n- 第二项")).toBe("第一项\n第二项")
    expect(toPlainText("1. 第一\n2. 第二")).toBe("第一\n第二")
  })

  it("keeps the url of a link", () => {
    expect(toPlainText("[文档](https://example.com/doc)")).toBe("文档: https://example.com/doc")
  })

  it("keeps the url of an image without the markdown bang", () => {
    expect(toPlainText("![图](https://example.com/a.png)")).toBe("图: https://example.com/a.png")
  })

  it("keeps bare urls untouched", () => {
    expect(toPlainText("看这里 https://example.com/a 谢谢")).toBe(
      "看这里 https://example.com/a 谢谢",
    )
  })

  it("keeps the code block content without the fence", () => {
    expect(toPlainText("```js\nconsole.log(1)\n```")).toBe("console.log(1)")
  })

  it("does not mistake multiplication for emphasis", () => {
    expect(toPlainText("2 * 3 * 4 = 24")).toBe("2 * 3 * 4 = 24")
  })

  it("drops html tags", () => {
    expect(toPlainText("<b>粗</b>")).toBe("粗")
  })

  it("keeps plain text as it is", () => {
    expect(toPlainText("普通的一句话")).toBe("普通的一句话")
  })
})

describe("dropTables", () => {
  it("drops the whole table block", () => {
    const content = ["前面", "", "| 名称 | 说明 |", "| --- | --- |", "| a | b |", "", "后面"].join(
      "\n",
    )
    expect(dropTables(content)).toBe(["前面", "", "", "后面"].join("\n"))
  })

  it("drops a table without leading pipes", () => {
    const content = ["名称 | 说明", "--- | ---", "a | b"].join("\n")
    expect(dropTables(content)).toBe("")
  })

  it("keeps lines that only contain a pipe", () => {
    expect(dropTables("a | b")).toBe("a | b")
  })

  it("keeps a table row that is not followed by a delimiter", () => {
    expect(dropTables("| a | b |\n普通一行")).toBe("| a | b |\n普通一行")
  })
})

describe("splitGraphemes", () => {
  it("keeps a zwj emoji sequence in one piece", () => {
    expect(splitGraphemes("👨‍👩‍👦")).toEqual(["👨‍👩‍👦"])
  })

  it("keeps a skin tone modifier with its base", () => {
    expect(splitGraphemes("👍🏻")).toEqual(["👍🏻"])
  })

  it("keeps a regional indicator flag in one piece", () => {
    expect(splitGraphemes("🇨🇳")).toEqual(["🇨🇳"])
  })

  it("keeps a combining sequence in one piece", () => {
    expect(splitGraphemes("é")).toEqual(["é"])
  })
})

describe("splitMessage", () => {
  it("keeps a short message in one chunk", () => {
    expect(splitMessage("短消息")).toEqual(["短消息"])
  })

  it("keeps the original line breaks", () => {
    expect(splitMessage("第一行\n\n第二行", 20)).toEqual(["第一行\n\n第二行"])
  })

  it("splits a long line into chunks of the given size", () => {
    expect(splitMessage("abcdef", 2)).toEqual(["ab", "cd", "ef"])
  })

  it("splits on line boundaries when a line fits", () => {
    expect(splitMessage("aaaa\nbbbb", 9)).toEqual(["aaaa\nbbbb"])
    expect(splitMessage("aaaa\nbbbb", 5)).toEqual(["aaaa", "bbbb"])
  })

  it("never cuts a grapheme cluster in half", () => {
    const chunks = splitMessage("👨‍👩‍👦👨‍👩‍👦", 1)
    expect(chunks).toEqual(["👨‍👩‍👦", "👨‍👩‍👦"])
  })

  it("does not cut a surrogate pair in half", () => {
    expect(splitMessage("👍👍", 1)).toEqual(["👍", "👍"])
  })

  it("returns the content as it is when it is empty", () => {
    expect(splitMessage("")).toEqual([""])
  })
})

describe("prepareOutbound", () => {
  it("strips markdown before splitting", () => {
    expect(prepareOutbound("# 标题", MAX_MESSAGE_CHARS)).toEqual(["标题"])
  })

  it("drops a table only reply", () => {
    expect(prepareOutbound("| a | b |\n| --- | --- |\n| 1 | 2 |")).toEqual([""])
  })
})
