/** 面板里的时间、时长与数字格式化：全部走平台原生 `Intl`，自带中文本地化。 */

const dateTime = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "short",
  timeStyle: "medium",
})

const clock = new Intl.DateTimeFormat("zh-CN", { timeStyle: "medium" })

const number = new Intl.NumberFormat("zh-CN")

/** 时间戳 → 本地日期时间。 */
export function formatDate(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "-"
  return dateTime.format(ms)
}

/** 时间戳 → 本地时分秒。 */
export function formatClock(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "-"
  return clock.format(ms)
}

/** 毫秒 → 中文时长，例如「2 小时 3 分」。 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "-"
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`
  const days = Math.floor(hours / 24)
  return `${days} 天 ${hours % 24} 小时`
}

/** 数字 → 千分位。 */
export function formatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-"
  return number.format(value)
}

/** 剩余额度 → 展示文本。 */
export function formatRemaining(value: number | null | undefined): string {
  if (value === null || value === undefined) return "不限"
  return formatNumber(value)
}

/** JSON 字符串的短展示：解析失败就原样返回。 */
export function formatJson(value: unknown): string {
  if (value === undefined) return ""
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
