/** 零宽字符：可以用来把关键字拆成看起来正常、匹配不上的形式。 */
export const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF]/g

/** 截断过长的地址，避免日志被超长 URL 淹没。 */
export function truncateForLog(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}
