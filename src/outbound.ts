import removeMd from "remove-markdown"

/** QQ 单条消息的保守长度上限，超过时按段发送。 */
export const MAX_MESSAGE_CHARS = 4000

/**
 * 剥离 markdown 的选项。
 *
 * 列表符号全部去掉，只留纯文本；链接与图片保留 URL，
 * 否则用户拿到的是一个没有目标的引用。
 */
const MARKDOWN_OPTIONS = {
  stripListLeaders: true,
  listUnicodeChar: "",
  separateLinksAndTexts: ": ",
} as const

/** 按字素簇切分，避免把 emoji 序列、肤色修饰符和组合字符切坏。 */
const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" })

/** 判断一行是不是 markdown 表格的分隔行：每个单元格都只由 - 和 : 组成。 */
function isTableDelimiter(line: string): boolean {
  const cells = line
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0)
  if (cells.length === 0) return false
  return cells.every((cell) => /^:?-+:?$/.test(cell))
}

/** 丢弃 markdown 表格：表头、分隔行和数据行整块删掉，QQ 里表格没法看。 */
export function dropTables(content: string): string {
  const lines = content.split("\n")
  const kept: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ""
    const next = index + 1 < lines.length ? (lines[index + 1] ?? "") : undefined
    if (line.includes("|") && next !== undefined && isTableDelimiter(next)) {
      index += 2
      while (index < lines.length && (lines[index] ?? "").includes("|")) index += 1
      continue
    }
    kept.push(line)
    index += 1
  }
  return kept.join("\n")
}

/** 图片语法降级成普通链接，否则剥离后会残留 markdown 的 ! 前缀。 */
function normalizeImages(content: string): string {
  return content.replace(/!\[([^\]]*)\]\(/g, "[$1](")
}

/**
 * 把 markdown 剥成 QQ 友好的纯文本。
 *
 * 表格整块丢弃；链接和图片保留 URL；列表符号去掉，只留正文。
 */
export function toPlainText(content: string): string {
  return removeMd(normalizeImages(dropTables(content)), MARKDOWN_OPTIONS)
}

/** 按字素簇切分文本。 */
export function splitGraphemes(content: string): string[] {
  return Array.from(segmenter.segment(content), (item) => item.segment)
}

/**
 * 按长度切分消息，保留原有换行与空行。
 *
 * 长度按字素簇计算，不会把 emoji 序列或组合字符切坏。
 */
export function splitMessage(content: string, max = MAX_MESSAGE_CHARS): string[] {
  const limit = Math.max(1, max)
  const chunks: string[] = []
  let current = ""
  let currentLength = 0
  for (const line of content.split("\n")) {
    const parts = splitGraphemes(line)
    const candidateLength = currentLength + (currentLength > 0 ? 1 : 0) + parts.length
    if (candidateLength <= limit) {
      current = currentLength > 0 ? `${current}\n${line}` : line
      currentLength = candidateLength
      continue
    }
    if (currentLength > 0) {
      chunks.push(current)
      current = ""
      currentLength = 0
    }
    let rest = parts
    while (rest.length > limit) {
      chunks.push(rest.slice(0, limit).join(""))
      rest = rest.slice(limit)
    }
    current = rest.join("")
    currentLength = rest.length
  }
  if (currentLength > 0) chunks.push(current)
  return chunks.length > 0 ? chunks : [content]
}

/** 出站文本的统一处理：剥掉 markdown，再按字素簇切分。 */
export function prepareOutbound(content: string, max = MAX_MESSAGE_CHARS): string[] {
  return splitMessage(toPlainText(content), max)
}
