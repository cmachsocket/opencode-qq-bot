/** 零宽字符：可以用来把关键字拆成看起来正常、匹配不上的形式。 */
export const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF]/g

/** 截断过长的地址，避免日志被超长 URL 淹没。 */
export function truncateForLog(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** 截断标记：告诉读者后面还有内容被截掉了。 */
export const TRUNCATION_MARKER = "…（已截断）"

/**
 * 自然断点，按优先级排列。
 *
 * 先段落、再行、再句子、最后是空格：越靠前越像一个完整的意思单元。
 */
const BREAKS = ["\n\n", "\n", "。", "！", "？", "；", "，", ".", "!", "?", ";", ",", " "]

/**
 * 温和截断：断在自然边界上，并标出被截掉的部分。
 *
 * 按字数硬切会把句子拦腰砍断，读起来像坏掉了。
 * 这里先按码点切出上限，再退回最后一个自然断点，末尾补上标记，
 * 让人一眼看出「后面还有内容」，而不是内容凭空少了半句。
 * 找不到自然断点时（整段没有标点的长串）只能按码点切，标记照常加上。
 */
export function softTruncate(value: string, max: number, marker = TRUNCATION_MARKER): string {
  const chars = Array.from(value)
  if (chars.length <= max) return value
  const tail = Array.from(marker)
  const budget = max - tail.length
  // 上限比标记还小：留不出标记的位置，只能按码点切。
  if (budget <= 0) return chars.slice(0, Math.max(0, max)).join("")
  const head = chars.slice(0, budget).join("")
  for (const point of BREAKS) {
    const index = head.lastIndexOf(point)
    if (index <= 0) continue
    return `${head.slice(0, index + point.length).trimEnd()}${marker}`
  }
  return `${head.trimEnd()}${marker}`
}
