import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import type { Logger } from "../logger"
import { chatSlug, dateKey } from "./format"

/**
 * 一行聊天素材。
 *
 * 素材是给模型看的中间态：只保留文本，图片与语音只留占位符。
 */
export interface DiaryLine {
  /** NapCat 消息 ID，回补时用它去重。 */
  id: string
  /** 消息时间（秒）。 */
  time: number
  /** 发送者 QQ 号。 */
  userId: string
  /** 发送者显示名，取不到时退到 QQ 号。 */
  name: string
  /** 净化并截断后的正文。 */
  text: string
  /** 是否是机器人自己的消息。 */
  self: boolean
  /** 是否来自历史回补。 */
  backfilled: boolean
}

/** 素材收集器的依赖。 */
export interface DiaryCollectorDeps {
  /** 日记根目录，素材放在它下面的 `raw/` 子目录里。 */
  root: string
  logger: Logger
  /** 单行素材的最大字符数。 */
  maxLineChars: number
  /** 单天单聊天的素材行数上限。 */
  maxLinesPerDay: number
}

/** 素材文件名的形状。 */
const RAW_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

/**
 * 按码点截断。
 *
 * 按码点而不是 UTF-16 码元截：emoji 不会被切成半个。
 */
export function truncateChars(value: string, max: number): string {
  const chars = Array.from(value)
  if (chars.length <= max) return value
  return chars.slice(0, max).join("")
}

/**
 * 聊天素材的累积与落盘。
 *
 * 素材按天分文件：`<root>/raw/<聊天目录>/<日期>.jsonl`，每行一个 JSON 对象。
 * 素材是中间产物，按保留天数清理，不影响已生成的日记。
 */
export class DiaryCollector {
  /** 每天的行数缓存，避免每条消息都重新数一遍文件。 */
  private readonly counts = new Map<string, number>()

  constructor(private readonly deps: DiaryCollectorDeps) {}

  /** 素材根目录。 */
  rawRoot(): string {
    return join(this.deps.root, "raw")
  }

  /** 某个聊天的素材目录。 */
  rawDir(chat: string): string {
    return join(this.rawRoot(), chatSlug(chat))
  }

  /** 某天的素材文件。 */
  rawFile(chat: string, date: string): string {
    return join(this.rawDir(chat), `${date}.jsonl`)
  }

  /**
   * 追加一行素材。
   *
   * 落盘失败只记日志，不影响聊天本身。
   *
   * @returns 是否真的写进去了；超过单天行数上限时返回 false。
   */
  async append(chat: string, line: DiaryLine): Promise<boolean> {
    const date = dateKey(new Date(line.time * 1000))
    const count = await this.lineCount(chat, date)
    if (count >= this.deps.maxLinesPerDay) {
      this.deps.logger.warn(
        `${chat} ${date} 的日记素材已达上限 ${this.deps.maxLinesPerDay} 行，丢弃新素材`,
      )
      return false
    }
    const record: DiaryLine = { ...line, text: truncateChars(line.text, this.deps.maxLineChars) }
    try {
      await mkdir(this.rawDir(chat), { recursive: true })
      await appendFile(this.rawFile(chat, date), `${JSON.stringify(record)}\n`, "utf8")
    } catch (error) {
      this.deps.logger.warn(`${chat} ${date} 的日记素材写入失败`, error)
      return false
    }
    this.counts.set(`${chat}|${date}`, count + 1)
    return true
  }

  /** 读某天的全部素材行。 */
  async read(chat: string, date: string): Promise<DiaryLine[]> {
    let content: string
    try {
      content = await readFile(this.rawFile(chat, date), "utf8")
    } catch {
      return []
    }
    const lines: DiaryLine[] = []
    for (const raw of content.split("\n")) {
      const trimmed = raw.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as DiaryLine
        if (typeof parsed?.text !== "string") continue
        lines.push(parsed)
      } catch {
        // 半行或坏行：跳过，不让一行坏数据毁掉整天的素材。
        this.deps.logger.warn(`${chat} ${date} 的日记素材有一行无法解析，已跳过`)
      }
    }
    return lines
  }

  /** 某天有多少行素材。 */
  async count(chat: string, date: string): Promise<number> {
    return await this.lineCount(chat, date)
  }

  /** 某天有没有素材。 */
  async has(chat: string, date: string): Promise<boolean> {
    return (await this.count(chat, date)) > 0
  }

  /** 某天的行数；第一次访问时数一遍文件并缓存。 */
  private async lineCount(chat: string, date: string): Promise<number> {
    const key = `${chat}|${date}`
    const cached = this.counts.get(key)
    if (cached !== undefined) return cached
    let count = 0
    try {
      const content = await readFile(this.rawFile(chat, date), "utf8")
      count = content.split("\n").filter((line) => line.trim().length > 0).length
    } catch {
      count = 0
    }
    this.counts.set(key, count)
    return count
  }

  /**
   * 清理过期的素材文件。
   *
   * 只清素材，成品日记不动：日记不设条数上限，也不自动清理。
   *
   * @returns 删掉的文件数。
   */
  async cleanup(retentionDays: number): Promise<number> {
    const days = Math.max(1, Math.floor(retentionDays))
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const dirs = await readdir(this.rawRoot(), { withFileTypes: true }).catch(() => [])
    let removed = 0
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const files = await readdir(join(this.rawRoot(), dir.name)).catch(() => [] as string[])
      for (const name of files) {
        const date = RAW_FILE.exec(name)?.[1]
        if (!date) continue
        const file = join(this.rawRoot(), dir.name, name)
        const info = await stat(file).catch(() => undefined)
        if (!info) continue
        if (info.mtimeMs >= cutoff) continue
        await rm(file, { force: true }).catch(() => {})
        removed += 1
      }
    }
    if (removed > 0) this.deps.logger.info(`已清理 ${removed} 个过期日记素材文件`)
    return removed
  }
}
