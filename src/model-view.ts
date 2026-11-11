/**
 * 模型视图：把群友可控的 QQ 文本整理成能直接进提示词的形式。
 *
 * 群里来的文本完全可控，原样拼进提示词就能伪造段落或跨行结构；
 * 这里统一做结构净化，并给每条消息标上绝对时间。
 *
 * 净化分两层：`sanitizeUntrustedText` 负责单段文本里的换行、零宽字符与全角括号，
 * `neutralizeStructureTags` 负责拼好之后整条消息里的结构标签——
 * 群友把 `<quote>` 拆成两段发过来，逐段净化匹配不到，只有整体净化才拦得住。
 */

import { ZERO_WIDTH } from "./text"

/** 提示词里的结构标签；群友文本里出现同样字样时换成全角，避免伪造。 */
const STRUCTURE_TAG = /<\/?(quote|forward|history|chat)>/gi

/** 换行类字符：换行、段分隔符、下一行、垂直制表、换页。 */
const NEWLINE_LIKE = /[\r\n\u2028\u2029\u0085\u000B\u000C]+/g
/** 控制字符：显示名里出现会破坏结构。 */
const CONTROL = /[\u0000-\u001F\u007F]+/g
/** 私用区字符：插件用它给结构标签占位，群友文本里的必须清掉，否则能伪造占位符。 */
const PRIVATE_USE = /[\uE000-\uF8FF]/g
/** 私用区占位符的起点。 */
const PLACEHOLDER_START = 0xe000

/**
 * 把结构标签换成全角。
 *
 * 只对一段文本调用是不够的：`<` 与 `quote>` 分处两段时匹配不到，拼起来仍是一个标签。
 * 这里对拼好的整段文本调用，跨段拼接伪造也挡得住。
 */
export function neutralizeStructureTags(value: string): string {
  return String(value ?? "").replace(STRUCTURE_TAG, (tag) =>
    tag.replace(/</g, "＜").replace(/>/g, "＞"),
  )
}

/**
 * 净化群友可控文本。
 *
 * 换行类字符压成空格、零宽字符直接去掉，全角方括号换成半角，
 * 提示词里的结构标签换成全角，这样群友文本再也伪造不出段落。
 */
export function sanitizeUntrustedText(value: string): string {
  return neutralizeStructureTags(
    String(value ?? "")
      .replace(/【/g, "[")
      .replace(/】/g, "]")
      .replace(NEWLINE_LIKE, " ")
      .replace(ZERO_WIDTH, "")
      .replace(PRIVATE_USE, ""),
  )
}

/**
 * 结构标签守卫：插件生成的结构标签在整体净化时先换成占位符。
 *
 * 群友文本里的 `<quote>` 之类必须中和，插件自己展开的引用块与转发块要原样保留。
 * 占位符用私用区字符（单个码点，截断时不会被切成两半），
 * 群友文本里的私用区字符会被净化掉，伪造不出占位符。
 */
export class StructureTagGuard {
  private readonly tags: string[] = []

  /** 登记一个插件生成的结构标签，返回可安全拼接的占位符。 */
  protect(tag: string): string {
    const index = this.tags.push(tag) - 1
    return String.fromCharCode(PLACEHOLDER_START + index)
  }

  /** 把占位符还原成原来的标签。 */
  restore(text: string): string {
    return text.replace(/[\uE000-\uF8FF]/g, (char) => {
      const tag = this.tags[char.charCodeAt(0) - PLACEHOLDER_START]
      return tag ?? ""
    })
  }
}

/** 净化发送者显示名：群名片可被伪造，去掉控制字符与结构符号。 */
export function sanitizeSenderName(value: string): string {
  return (
    String(value ?? "")
      .replace(ZERO_WIDTH, "")
      .replace(CONTROL, " ")
      // 私用区字符是结构标签的占位符，群名片里出现会被还原成真正的标签。
      .replace(PRIVATE_USE, "")
      .replace(/[【】]/g, (char) => (char === "【" ? "[" : "]"))
      .replace(/[<>]/g, (char) => (char === "<" ? "＜" : "＞"))
      // 括号是角色标记的写法：群名片里带着括号就能伪造出 `(owner)`。
      .replace(/[()（）]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  )
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

import type { Role } from "./tools/policy"

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
  /** 发送者角色；owner / admin 会在模型视图里带上对应的角色标记。 */
  role?: Role
}

/** 拼成一行模型视图消息：`[绝对时间] 名字(owner): 正文`；普通成员没有角色标记。 */
export function formatModelMessage(message: ModelMessage): string {
  // QQ 号来自 QQ 服务，但仍是外部输入，按显示名净化一遍。
  const userId = sanitizeSenderName(message.userId)
  const name = sanitizeSenderName(message.sender) || userId || "未知用户"
  const stamp = formatTimestamp(message.time)
  const prefix = stamp ? `[${stamp}] ` : ""
  // 只给 owner / admin 加角色标记，让模型知道这句话是谁说的。
  const role = message.role === "owner" ? "(owner)" : message.role === "admin" ? "(admin)" : ""
  return `${prefix}${name}${role}: ${message.text.trim()}`
}
