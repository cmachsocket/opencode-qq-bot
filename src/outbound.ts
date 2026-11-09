import removeMd from "remove-markdown"

/** QQ 单条消息的保守长度上限，超过时按段发送。 */
export const MAX_MESSAGE_CHARS = 4000

/** 分段发送的节奏参数。 */
export interface ReplyRhythm {
  /** 固定间隔（毫秒），兼容旧的 `sendDelayMs`。 */
  sendDelayMs: number
  /** 随机间隔下限（毫秒）。 */
  minDelayMs: number
  /** 随机间隔上限（毫秒）。 */
  maxDelayMs: number
}

/**
 * 算出两段之间要等多久。
 *
 * 配了随机区间就在区间里等，看起来更像人在分条打字；
 * 没配随机区间就沿用旧的固定间隔，不改变原有行为。
 */
export function segmentDelayMs(rhythm: ReplyRhythm, random: () => number = Math.random): number {
  const min = Math.max(0, Math.floor(rhythm.minDelayMs))
  const max = Math.max(0, Math.floor(rhythm.maxDelayMs))
  if (max > 0) {
    const low = Math.min(min, max)
    if (max === low) return low
    return low + Math.floor(random() * (max - low + 1))
  }
  if (min > 0) return min
  return Math.max(0, Math.floor(rhythm.sendDelayMs))
}

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

/** 一行的单元格数量：去掉首尾竖线带来的空段。 */
function cellCount(line: string): number {
  const trimmed = line.trim()
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed
  const body = inner.endsWith("|") ? inner.slice(0, -1) : inner
  return body.split("|").length
}

/**
 * 判断一行是不是表格行。
 *
 * 只有首尾都带竖线、且列数与表头一致的行才算；
 * 否则表格后面正文里的一个竖线就会把整条正文当成表格行吞掉。
 */
function isTableRow(line: string, columns: number): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return false
  return cellCount(trimmed) === columns
}

/**
 * 丢弃 markdown 表格：表头、分隔行和数据行整块删掉，QQ 里表格没法看。
 *
 * 只认首尾带竖线的标准表格；表格后面的正文带着竖线也不会被当成数据行。
 */
export function dropTables(content: string): string {
  const lines = content.split("\n")
  const kept: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ""
    const next = index + 1 < lines.length ? (lines[index + 1] ?? "") : undefined
    const columns = next !== undefined ? cellCount(line) : 0
    // 表头与分隔行的列数一致，才当成一张表。
    if (
      next !== undefined &&
      isTableDelimiter(next) &&
      columns > 0 &&
      cellCount(next) === columns &&
      isTableRow(line, columns)
    ) {
      index += 2
      while (index < lines.length && isTableRow(lines[index] ?? "", columns)) index += 1
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
 * 首部的空行也算内容，不会被吞掉。
 */
export function splitMessage(content: string, max = MAX_MESSAGE_CHARS): string[] {
  const limit = Math.max(1, max)
  const chunks: string[] = []
  let current = ""
  let currentLength = 0
  // 当前这段已经放了几行：空行长度为 0，只能靠行数区分“还没内容”和“有空行”。
  let currentLines = 0
  for (const line of content.split("\n")) {
    const parts = splitGraphemes(line)
    const separator = currentLines > 0 ? 1 : 0
    const candidateLength = currentLength + separator + parts.length
    if (candidateLength <= limit) {
      current = currentLines > 0 ? `${current}\n${line}` : line
      currentLength = candidateLength
      currentLines += 1
      continue
    }
    if (currentLines > 0) {
      chunks.push(current)
      current = ""
      currentLength = 0
      currentLines = 0
    }
    let rest = parts
    while (rest.length > limit) {
      chunks.push(rest.slice(0, limit).join(""))
      rest = rest.slice(limit)
    }
    current = rest.join("")
    currentLength = rest.length
    currentLines = 1
  }
  if (currentLines > 0 && (current.length > 0 || chunks.length === 0)) chunks.push(current)
  return chunks.length > 0 ? chunks : [content]
}

/** 出站文本的统一处理：剥掉 markdown，再按字素簇切分。 */
export function prepareOutbound(content: string, max = MAX_MESSAGE_CHARS): string[] {
  return splitMessage(toPlainText(content), max)
}
