/** 时间显示用的默认时区：QQ 用户所在的东八区。 */
export const DEFAULT_TIME_ZONE = "Asia/Shanghai"

/** 格式化器缓存：`Intl.DateTimeFormat` 构造开销大，按字段与时区复用。 */
const TIMESTAMP_FORMATS = new Map<string, Intl.DateTimeFormat>()
const DATE_TIME_FORMATS = new Map<string, Intl.DateTimeFormat>()

function createFormat(
  cache: Map<string, Intl.DateTimeFormat>,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  let format = cache.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat("sv-SE", { ...options, timeZone })
    cache.set(timeZone, format)
  }
  return format
}

/** 绝对时间标注：指定时区的 `YY-MM-DD HH:MM`；时间无效时返回空串。 */
export function formatTimestamp(seconds: number, timeZone = DEFAULT_TIME_ZONE): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ""
  return createFormat(TIMESTAMP_FORMATS, timeZone, {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(seconds * 1000))
}

/** 当前时间：指定时区的 `YYYY-MM-DD HH:mm:ss`。 */
export function formatDateTime(now: Date, timeZone = DEFAULT_TIME_ZONE): string {
  return createFormat(DATE_TIME_FORMATS, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now)
}
