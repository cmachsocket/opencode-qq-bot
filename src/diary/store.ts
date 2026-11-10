import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Logger } from "../logger"
import {
  chatSlug,
  dateKey,
  diaryFileName,
  fallbackTitle,
  parseDiary,
  serializeDiary,
  type DiaryEntry,
  type DiarySource,
} from "./format"

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
    let content: string
    try {
      content = await readFile(this.filePath(chat, date), "utf8")
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
    const dir = this.chatDir(chat)
    await mkdir(dir, { recursive: true })
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
    await writeFile(this.filePath(chat, date), serializeDiary(entry), "utf8")
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
