import { parseTargetKey, targetLabel } from "../chat"

/**
 * 日记的文件格式：日期键、聊天目录名与 front matter。
 *
 * 日记是自包含的 Markdown 文件：元数据放在 front matter 里，
 * 程序读它，人也能直接打开看。
 */

/** 日记来源：自动总结、命令手写、模型用工具写入。 */
export type DiarySource = "auto" | "manual" | "model"

/** 日记的元数据，对应文件里的 front matter。 */
export interface DiaryMeta {
  /** 日期键，形如 `2026-11-10`。 */
  date: string
  /** 聊天键，形如 `group:123`。 */
  chat: string
  /** 聊天可读标识，形如 `群 123`；旧文件里可能没有。 */
  chat_label?: string
  /** 来源。 */
  source: DiarySource
  /** 首次写入时间（ISO 字符串）。 */
  created: string
  /** 最近更新时间（ISO 字符串）。 */
  updated: string
}

/** 一篇日记的完整内容。 */
export interface DiaryEntry extends DiaryMeta {
  /** 标题，不含 `#`。 */
  title: string
  /** 正文。 */
  body: string
}

/** 解析出来的日记。 */
export interface ParsedDiary {
  meta: DiaryMeta
  title: string
  body: string
}

/** 合法的来源。 */
const SOURCES: readonly DiarySource[] = ["auto", "manual", "model"]

/** 日期键的形状。 */
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

/**
 * 本地时区的日期键。
 *
 * 用本地时区而不是 UTC：聊天里的「今天」是用户所在时区的今天。
 */
export function dateKey(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/**
 * 日期键是否合法。
 *
 * 只看形状不够：`2026-02-30` 形状对得上，实际并不存在。
 */
export function isDateKey(value: string): boolean {
  if (!DATE_KEY.test(value)) return false
  const parsed = new Date(`${value}T00:00:00`)
  return !Number.isNaN(parsed.getTime()) && dateKey(parsed) === value
}

/**
 * 聊天目录名：聊天键里的 `:` 换成 `-`。
 *
 * 目录名直接来自外部输入（群号、私聊号），先兜一层字符白名单，
 * 免得出现路径分隔符或隐藏目录。
 */
export function chatSlug(chat: string): string {
  const slug = chat.replace(/[^A-Za-z0-9_-]/g, "-")
  return slug || "unknown"
}

/** 日记成品文件名。 */
export function diaryFileName(date: string): string {
  return `${date}.md`
}

/** 标题为空时的兜底。 */
export function fallbackTitle(date: string): string {
  return `${date} 的日记`
}

/**
 * 聊天键的可读名称。
 *
 * 日记的正文、列表与发送说明都要让人一眼看出是群聊还是私聊，
 * 所以统一用「群 123」「私聊 456」，解析不了时原样返回。
 */
export function chatLabel(chat: string): string {
  const target = parseTargetKey(chat)
  return target ? targetLabel(target) : chat
}

/**
 * 序列化一篇日记。
 *
 * 顺序固定，便于人工阅读与 `diff`。
 */
export function serializeDiary(entry: DiaryEntry): string {
  return [
    "---",
    `date: ${entry.date}`,
    `chat: ${entry.chat}`,
    `chat_label: ${chatLabel(entry.chat)}`,
    `source: ${entry.source}`,
    `created: ${entry.created}`,
    `updated: ${entry.updated}`,
    "---",
    "",
    `# ${entry.title}`,
    "",
    entry.body.trim(),
    "",
  ].join("\n")
}

/**
 * 解析一篇日记。
 *
 * front matter 与正文之间用空行分开；正文第一行是标题。
 * 解析不了就返回 undefined，调用方按「没有日记」处理。
 */
export function parseDiary(content: string): ParsedDiary | undefined {
  const text = String(content ?? "").replace(/\r\n/g, "\n")
  if (!text.startsWith("---\n")) return undefined
  const end = text.indexOf("\n---", 3)
  if (end < 0) return undefined
  const meta: Record<string, string> = {}
  for (const line of text.slice(4, end).split("\n")) {
    const separator = line.indexOf(": ")
    if (separator <= 0) continue
    meta[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  const rest = text.slice(end + 4).replace(/^\n+/, "")
  const lines = rest.split("\n")
  let title = ""
  let bodyStart = 0
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("# ")) {
      title = trimmed.slice(2).trim()
      bodyStart = index + 1
    }
    break
  }
  const date = meta.date ?? ""
  const source = SOURCES.includes(meta.source as DiarySource)
    ? (meta.source as DiarySource)
    : "auto"
  return {
    meta: {
      date,
      chat: meta.chat ?? "",
      ...(meta.chat_label ? { chat_label: meta.chat_label } : {}),
      source,
      created: meta.created ?? "",
      updated: meta.updated ?? "",
    },
    title: title || fallbackTitle(date),
    body: lines.slice(bodyStart).join("\n").trim(),
  }
}
