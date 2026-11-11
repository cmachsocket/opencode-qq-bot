import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Logger } from "../logger"
import {
  chatSlug,
  dateKey,
  diaryFileName,
  fallbackTitle,
  isDateKey,
  parseDiary,
  serializeDiary,
  type DiaryEntry,
  type DiarySource,
} from "./format"
import { isInside, realDir, realExisting } from "./paths"

/** 日记正文扫描时最多读这么多字节。 */
export const DIARY_SCAN_BYTES = 4096

/**
 * 读取日记文件开头的一段，用于出站敏感信息扫描。
 *
 * 只读开头：日记正文有长度上限，4KB 足够覆盖一篇完整的日记。
 */
export async function readDiaryHead(file: string, maxBytes = DIARY_SCAN_BYTES): Promise<string> {
  const handle = await open(file, "r")
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
}

/** 日记列表里的摘要：只要日期与标题，不带正文。 */
export interface DiarySummary {
  /** 日期键。 */
  date: string
  /** 标题。 */
  title: string
  /** 来源。 */
  source: DiarySource
}

/** 日记存储的依赖。 */
export interface DiaryStoreDeps {
  /** 日记根目录。 */
  root: string
  logger: Logger
}

/**
 * 日记的读写。
 *
 * 日记是文件而不是数据库条目：一个聊天一个目录，一天一个文件。
 * 成品不设条数上限，也不自动清理。
 */
export class DiaryStore {
  constructor(private readonly deps: DiaryStoreDeps) {}

  /** 某个聊天的日记目录。 */
  chatDir(chat: string): string {
    return join(this.deps.root, chatSlug(chat))
  }

  /** 某篇日记的文件路径。 */
  filePath(chat: string, date: string): string {
    return join(this.chatDir(chat), diaryFileName(date))
  }

  /**
   * 读一篇日记。
   *
   * 文件不存在或读不出来都按「没有日记」处理，不缓存失败结果。
   */
  async read(chat: string, date: string): Promise<DiaryEntry | undefined> {
    if (!isDateKey(date)) {
      this.deps.logger.warn(`${chat} 的日记日期不合法：${date}`)
      return undefined
    }
    const root = await realDir(this.deps.root)
    const file = await realExisting(this.filePath(chat, date))
    if (!file) return undefined
    if (!isInside(root, file)) {
      this.deps.logger.warn(`${chat} ${date} 的日记路径落在日记目录之外，拒绝读取`)
      return undefined
    }
    let content: string
    try {
      content = await readFile(file, "utf8")
    } catch {
      return undefined
    }
    const parsed = parseDiary(content)
    if (!parsed) {
      this.deps.logger.warn(`${chat} ${date} 的日记格式无法解析，按没有日记处理`)
      return undefined
    }
    return {
      ...parsed.meta,
      date: parsed.meta.date || date,
      chat: parsed.meta.chat || chat,
      title: parsed.title,
      body: parsed.body,
    }
  }

  /**
   * 写入一篇日记，同一天同一聊天只保留一篇。
   *
   * `created` 在首次写入时定下，覆盖写保持不变；`updated` 每次刷新。
   */
  async write(
    chat: string,
    date: string,
    input: { title: string; body: string; source: DiarySource },
  ): Promise<DiaryEntry> {
    if (!isDateKey(date)) throw new Error(`日期格式不对：${date}`)
    const dir = this.chatDir(chat)
    // 目录与文件都显式收紧权限：日记里是私聊原文，不能沿用 umask 的默认值。
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const root = await realDir(this.deps.root)
    const realDirectory = await realExisting(dir)
    if (!realDirectory || !isInside(root, realDirectory)) {
      throw new Error(`日记目录不在日记根目录内：${dir}`)
    }
    const file = this.filePath(chat, date)
    const realFile = await realExisting(file)
    if (realFile && !isInside(root, realFile)) {
      throw new Error(`日记文件不在日记根目录内：${file}`)
    }
    const existing = await this.read(chat, date)
    const now = new Date().toISOString()
    const entry: DiaryEntry = {
      date,
      chat,
      source: input.source,
      created: existing?.created || now,
      updated: now,
      title: input.title.trim() || fallbackTitle(date),
      body: input.body.trim(),
    }
    await writeFile(file, serializeDiary(entry), { encoding: "utf8", mode: 0o600 })
    return entry
  }

  /**
   * 列出最近的日记，按日期倒序。
   *
   * 只扫目录名，不读全部内容：文件名本身就是日期键。
   */
  async list(chat: string, limit: number): Promise<DiarySummary[]> {
    const names = await readdir(this.chatDir(chat)).catch(() => [] as string[])
    const dates = names
      .map((name) => /^(\d{4}-\d{2}-\d{2})\.md$/.exec(name)?.[1])
      .filter((value): value is string => Boolean(value))
      .sort()
      .reverse()
      .slice(0, Math.max(0, limit))
    const summaries: DiarySummary[] = []
    for (const date of dates) {
      const entry = await this.read(chat, date)
      if (!entry) continue
      summaries.push({ date: entry.date, title: entry.title, source: entry.source })
    }
    return summaries
  }

  /** 最近的一篇日记。 */
  async latest(chat: string): Promise<DiaryEntry | undefined> {
    const summaries = await this.list(chat, 1)
    const first = summaries[0]
    if (!first) return undefined
    return await this.read(chat, first.date)
  }

  /** 某天是否已经有自动生成的日记。 */
  async hasAuto(chat: string, date: string): Promise<boolean> {
    const entry = await this.read(chat, date)
    return entry?.source === "auto"
  }

  /** 今天的日期键。 */
  today(): string {
    return dateKey()
  }
}
