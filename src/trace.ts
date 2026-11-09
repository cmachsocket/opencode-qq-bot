import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { Logger } from "./logger"

/** 一次调用链里的关键节点。 */
export type TraceEventName = "event_received" | "agent_start" | "handler_start" | "response_sent"

/** 一条追踪记录。 */
export interface TraceSpan {
  /** 一次入站消息的追踪 id。 */
  traceId: string
  /** 节点自己的 id。 */
  spanId: string
  /** 节点名。 */
  name: TraceEventName
  /** 发生时间（毫秒）。 */
  at: number
  /** 聊天目标。 */
  target?: string
  /** 附加信息：只放元数据，不放消息正文。 */
  attributes?: Record<string, unknown>
}

/** 追踪器选项。 */
export interface TracerOptions {
  /** 是否记录追踪。 */
  enabled?: boolean
  /** 追踪文件目录，空表示由调用方给出默认目录。 */
  dir?: string
  /** 追踪文件总容量上限（MB）。 */
  maxSizeMb?: number
  /** 追踪文件保留天数。 */
  retentionDays?: number
  /** 内存里保留多少条记录。 */
  memorySpans?: number
  /** 取当前时间（毫秒），测试时可注入。 */
  now?: () => number
  /** 生成 id，测试时可注入。 */
  id?: () => string
  /** 日志器：写文件失败时告警。 */
  logger?: Logger
}

/** 追踪文件名前缀。 */
const FILE_PREFIX = "qq-bot-traces-"
/** 追踪文件后缀。 */
const FILE_SUFFIX = ".jsonl"
/** 内存里保留的记录条数上限。 */
const DEFAULT_MEMORY_SPANS = 1000
/** 容量上限的默认值（MB）。 */
const DEFAULT_MAX_SIZE_MB = 80
/** 保留天数的默认值。 */
const DEFAULT_RETENTION_DAYS = 7

interface TraceFile {
  /** 文件完整路径。 */
  path: string
  /** 文件大小（字节）。 */
  size: number
  /** 最后修改时间（毫秒）。 */
  mtime: number
}

/**
 * 调用链追踪。
 *
 * 一条入站消息拿一个 trace_id，事件接收、模型起跑、模型处理、出站回复
 * 各自记一个节点，事后按 trace_id 就能把这一轮串起来。
 *
 * 记录只存元数据（目标、消息号、字数），不存消息正文；文件按天写 JSONL，
 * 总容量与保留天数都有上限，超了先删旧文件。
 */
export class Tracer {
  private readonly enabled: boolean
  private readonly dir: string
  private readonly maxBytes: number
  private readonly retentionMs: number
  private readonly memoryLimit: number
  private readonly currentTime: () => number
  private readonly nextId: () => string
  private readonly logger: Logger | undefined
  /** 内存里的最近记录。 */
  private readonly memory: TraceSpan[] = []
  /** 追踪目录当前占用的字节数。 */
  private bytes = 0

  constructor(private readonly options: TracerOptions = {}) {
    this.enabled = options.enabled ?? true
    this.dir = options.dir ?? ""
    this.maxBytes = Math.max(1, options.maxSizeMb ?? DEFAULT_MAX_SIZE_MB) * 1024 * 1024
    this.retentionMs =
      Math.max(1, options.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 3600 * 1000
    this.memoryLimit = Math.max(1, options.memorySpans ?? DEFAULT_MEMORY_SPANS)
    this.currentTime = options.now ?? Date.now
    this.nextId = options.id ?? (() => randomUUID())
    this.logger = options.logger
  }

  /** 是否在记录。 */
  get active(): boolean {
    return this.enabled && this.dir.length > 0
  }

  /** 开一条新的追踪，返回 trace id。 */
  startTrace(): string {
    return this.nextId()
  }

  /** 记一个节点。 */
  async record(
    name: TraceEventName,
    traceId: string,
    attributes?: Record<string, unknown>,
    target?: string,
  ): Promise<void> {
    if (!this.active) return
    const span: TraceSpan = {
      traceId,
      spanId: this.nextId(),
      name,
      at: this.currentTime(),
      ...(target ? { target } : {}),
      ...(attributes && Object.keys(attributes).length > 0 ? { attributes } : {}),
    }
    this.memory.push(span)
    while (this.memory.length > this.memoryLimit) this.memory.shift()
    const line = `${JSON.stringify(span)}\n`
    try {
      await this.ensureRoom()
      await this.write(line)
    } catch (error) {
      this.logger?.warn("写入调用链追踪失败", error)
    }
  }

  /** 内存里保留的最近记录。 */
  spans(): TraceSpan[] {
    return [...this.memory]
  }

  /**
   * 清理追踪文件。
   *
   * 超过保留天数的文件直接删；总容量超了再从旧文件开始删。
   */
  async prune(): Promise<void> {
    if (!this.active) return
    const now = this.currentTime()
    const files = await this.listFiles()
    let total = 0
    for (const file of files) {
      if (now - file.mtime > this.retentionMs) {
        await unlink(file.path).catch(() => undefined)
        continue
      }
      total += file.size
    }
    if (total > this.maxBytes) {
      const sorted = [...files].sort((left, right) => left.mtime - right.mtime)
      for (const file of sorted) {
        if (total <= this.maxBytes * 0.9) break
        await unlink(file.path).catch(() => undefined)
        total -= file.size
      }
    }
    this.bytes = total
  }

  /** 追踪目录里的文件。 */
  private async listFiles(): Promise<TraceFile[]> {
    const entries = await readdir(this.dir).catch(() => [] as string[])
    const files: TraceFile[] = []
    for (const name of entries) {
      if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) continue
      const path = join(this.dir, name)
      const info = await stat(path).catch(() => undefined)
      if (!info?.isFile()) continue
      files.push({ path, size: info.size, mtime: info.mtimeMs })
    }
    return files
  }

  /** 容量不够时先清旧文件。 */
  private async ensureRoom(): Promise<void> {
    if (this.bytes < this.maxBytes) return
    await this.prune()
    if (this.bytes < this.maxBytes) return
    this.logger?.warn("调用链追踪已写满，丢弃新的追踪记录")
  }

  /** 追加一行到当天的追踪文件。 */
  private async write(line: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 }).catch(() => undefined)
    const path = join(this.dir, `${FILE_PREFIX}${this.day()}${FILE_SUFFIX}`)
    await appendFile(path, line, "utf8")
    this.bytes += Buffer.byteLength(line)
  }

  /** 当天的日期（UTC）。 */
  private day(): string {
    return new Date(this.currentTime()).toISOString().slice(0, 10)
  }
}
