/**
 * 模型视图：把群友可控的 QQ 文本整理成能直接进提示词的形式。
 *
 * 群里来的文本完全可控，原样拼进提示词就能伪造段落或跨行结构；
 * 这里统一做结构净化，并给每条消息标上绝对时间。
 */

/** 提示词里的结构标签；群友文本里出现同样字样时换成全角，避免伪造。 */
const STRUCTURE_TAG = /<\/?(quote|forward|history)>/gi

/** 换行类字符：换行、段分隔符、下一行、垂直制表、换页。 */
const NEWLINE_LIKE = /[\r\n\u2028\u2029\u0085\u000B\u000C]+/g
/** 零宽字符：可以用来把标签拆成看起来正常、匹配不上的形式。 */
const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF]/g
/** 控制字符：显示名里出现会破坏结构。 */
const CONTROL = /[\u0000-\u001F\u007F]+/g

/**
 * 净化群友可控文本。
 *
 * 换行类字符压成空格、零宽字符直接去掉，全角方括号换成半角，
 * 提示词里的结构标签换成全角，这样群友文本再也伪造不出段落。
 */
export function sanitizeUntrustedText(value: string): string {
  return String(value ?? "")
    .replace(/【/g, "[")
    .replace(/】/g, "]")
    .replace(NEWLINE_LIKE, " ")
    .replace(ZERO_WIDTH, "")
    .replace(STRUCTURE_TAG, (tag) => tag.replace(/</g, "＜").replace(/>/g, "＞"))
}

/** 净化发送者显示名：群名片可被伪造，去掉控制字符与结构符号。 */
export function sanitizeSenderName(value: string): string {
  return String(value ?? "")
    .replace(ZERO_WIDTH, "")
    .replace(CONTROL, " ")
    .replace(/[【】]/g, (char) => (char === "【" ? "[" : "]"))
    .replace(/[<>]/g, (char) => (char === "<" ? "＜" : "＞"))
    .replace(/\s+/g, " ")
    .trim()
}

const TIMESTAMP_FORMAT = new Intl.DateTimeFormat("sv-SE", {
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

/** 绝对时间标注：本地时区的 `YY-MM-DD HH:MM`；时间无效时返回空串。 */
export function formatTimestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ""
  return TIMESTAMP_FORMAT.format(new Date(seconds * 1000))
}

/** 一条消息的模型视图。 */
export interface ModelMessage {
  /** 发送者显示名。 */
  sender: string
  /** 发送者 QQ 号。 */
  userId: string
  /** 消息正文。 */
  text: string
  /** 发送时间（Unix 秒）。 */
  time: number
}

/** 拼成一行模型视图消息：`[绝对时间] 名字(QQ号): 正文`。 */
export function formatModelMessage(message: ModelMessage): string {
  const name = sanitizeSenderName(message.sender) || message.userId || "未知用户"
  const stamp = formatTimestamp(message.time)
  const prefix = stamp ? `[${stamp}] ` : ""
  return `${prefix}${name}(${message.userId}): ${message.text.trim()}`
}
