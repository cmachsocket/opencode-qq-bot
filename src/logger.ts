import { fsyncSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { inspect } from "node:util"
import winston from "winston"
import DailyRotateFile from "winston-daily-rotate-file"
import { unrefTimer } from "./async"
import { maskSecrets } from "./sensitive"

/** 日志级别。 */
export type LogLevel = "debug" | "info" | "warn" | "error"

/**
 * 日志器。
 *
 * 只有级别和消息，附加信息用 `...meta` 传，调用点与旧的 console 实现一致。
 */
export interface Logger {
  debug(message: string, ...meta: unknown[]): void
  info(message: string, ...meta: unknown[]): void
  warn(message: string, ...meta: unknown[]): void
  error(message: string, ...meta: unknown[]): void
}

/** 环形缓冲里的一条日志。 */
export interface LogEntry {
  /** 时间（ISO 字符串）。 */
  time: string
  /** 级别。 */
  level: LogLevel
  /** 正文。 */
  message: string
  /** 附加信息。 */
  meta: unknown[]
}

/** 日志器选项。 */
export interface LoggerOptions {
  /** 最低输出级别，默认 info。 */
  level?: LogLevel
  /** 是否写日志文件，默认 true。 */
  file?: boolean
  /** 日志目录，空表示用 XDG 状态目录。 */
  dir?: string
  /** 单个日志文件的大小上限，默认 5m。 */
  maxSize?: string
  /** 保留的历史日志份数，默认 5。 */
  maxFiles?: number
  /** 已知凭证明文，日志里会被额外打码。 */
  knownSecrets?: string[]
}

/** winston 存放最终输出的符号键。 */
const MESSAGE = Symbol.for("message")

/** 默认的单文件大小上限。 */
const DEFAULT_MAX_SIZE = "5m"
/** 默认保留的日志份数。 */
const DEFAULT_MAX_FILES = 5
/** 日志文件名模板，%DATE% 会替换成当天日期。 */
const FILE_NAME = "qq-bot-%DATE%.log"
/** meta 最多递归几层，再深就原样留下。 */
const MAX_META_DEPTH = 4
/** 关闭日志时最多等多久（毫秒），避免卸载卡死。 */
const CLOSE_TIMEOUT_MS = 2000
/** 进程内日志环形缓冲的容量。 */
const LOG_BUFFER_SIZE = 500
/** 日志级别的大小顺序。 */
const LEVEL_ORDER: readonly LogLevel[] = ["debug", "info", "warn", "error"]

/** 进程内的日志环形缓冲：面板直接看日志，不必去翻文件。 */
const logBuffer: LogEntry[] = []
/** 日志订阅者：面板的 SSE 增量推送用。 */
const logSubscribers = new Set<(entry: LogEntry) => void>()

/**
 * 读取最近的日志。
 *
 * @param options `limit` 取多少条，`level` 只看某个级别。
 */
export function readLogTail(options: { limit?: number; level?: LogLevel } = {}): LogEntry[] {
  const limit = Math.max(1, Math.min(options.limit ?? 200, LOG_BUFFER_SIZE))
  const level = options.level
  const filtered = level ? logBuffer.filter((entry) => entry.level === level) : logBuffer
  return filtered.slice(-limit)
}

/**
 * 订阅新写入的日志。
 *
 * @param listener 每条新日志调用一次。
 * @returns 取消订阅的函数。
 */
export function subscribeLogs(listener: (entry: LogEntry) => void): () => void {
  logSubscribers.add(listener)
  return () => {
    logSubscribers.delete(listener)
  }
}

/** 给缓冲里的副本打码：文件里打码了，面板里也必须打码。 */
function maskEntry(value: unknown, knownSecrets: string[]): unknown {
  if (typeof value === "string") return maskSecrets(value, { knownSecrets })
  if (!value || typeof value !== "object") return value
  try {
    const text = JSON.stringify(value)
    const masked = maskSecrets(text, { knownSecrets })
    return masked === text ? value : (JSON.parse(masked) as unknown)
  } catch {
    return value
  }
}

/** 把一条日志压进环形缓冲并通知订阅者。 */
function pushBuffer(
  level: LogLevel,
  message: string,
  meta: unknown[],
  knownSecrets: string[],
): void {
  const entry: LogEntry = {
    time: new Date().toISOString(),
    level,
    message: maskSecrets(message, { knownSecrets }),
    meta: meta.map((item) => maskEntry(item, knownSecrets)),
  }
  logBuffer.push(entry)
  while (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift()
  for (const listener of logSubscribers) {
    try {
      listener(entry)
    } catch {
      // 订阅者出错不影响日志本身。
    }
  }
}

/** 写文件的那一路传输。 */
interface FileTransport {
  transport: DailyRotateFile
  /** 当前打开的文件描述符，轮转后会更新。 */
  fd?: number
}

/** 已创建的日志器，插件卸载时按实例关闭。 */
interface LoggerHandle {
  api: Logger
  logger: winston.Logger
  files: FileTransport[]
  /** 当前最低级别：热更新时跟着变。 */
  level: LogLevel
}

const handles = new Set<LoggerHandle>()

/**
 * 默认日志目录。
 *
 * 优先用 `$XDG_STATE_HOME/opencode-qq-bot/logs`，没设置就用
 * `~/.local/state/opencode-qq-bot/logs`。
 */
export function defaultLogDir(): string {
  const stateHome = process.env.XDG_STATE_HOME?.trim()
  const base = stateHome && isAbsolute(stateHome) ? stateHome : join(homedir(), ".local", "state")
  return join(base, "opencode-qq-bot", "logs")
}

/** 判断是不是普通对象；Date、Map 之类的原样留下。 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * 规整 meta 里的值。
 *
 * Error 变成 `{name, message, stack}`，栈压成一行，避免日志文件里出现多行；
 * 普通对象与数组递归处理，别的类型原样保留。
 */
function normalizeValue(value: unknown, depth: number): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      // 有些上游错误（例如 opencode 的 Session.NotFoundError）没有 message，只能用名字顶上。
      message: value.message || value.name,
      stack: value.stack ? value.stack.replace(/\s*\n\s*/g, " ") : undefined,
    }
  }
  if (depth >= MAX_META_DEPTH) return value
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry, depth + 1))
  if (value && typeof value === "object" && isPlainObject(value)) {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      result[key] = normalizeValue(entry, depth + 1)
    }
    return result
  }
  return value
}

/** 规整 meta 列表，去掉 undefined。 */
function normalizeMeta(entries: unknown[]): unknown[] {
  const result: unknown[] = []
  for (const entry of entries) {
    if (entry === undefined) continue
    result.push(normalizeValue(entry, 0))
  }
  return result
}

/**
 * 打码格式：把最终序列化出来的那一行里的凭证换成占位符。
 *
 * 放在管道最后，console 与文件两条输出用的是同一套规则。
 */
function maskFormat(knownSecrets: string[]): winston.Logform.Format {
  return winston.format((info) => {
    const line = info[MESSAGE]
    if (typeof line === "string") {
      info[MESSAGE] = maskSecrets(line, { knownSecrets })
    }
    return info
  })()
}

/**
 * 控制台格式：保持旧的 `[时间] 级别 前缀 消息` 样式，附加信息跟在后面。
 */
function consoleFormat(prefix: string): winston.Logform.Format {
  return winston.format((info) => {
    const stamp = typeof info.timestamp === "string" ? info.timestamp : new Date().toISOString()
    const level = String(info.level).toUpperCase()
    const message = typeof info.message === "string" ? info.message : inspect(info.message)
    const meta = Array.isArray(info.meta) ? info.meta : []
    const details = meta.map((entry) => inspect(entry, { depth: MAX_META_DEPTH })).join(" ")
    const line = `[${stamp}] ${level} ${prefix} ${message}`
    info[MESSAGE] = details ? `${line} ${details}` : line
    return info
  })()
}

/**
 * 创建一个日志器。
 *
 * 控制台输出保持人类可读的旧格式，同时写一份按天轮转、大小有上限的 JSON 日志文件；
 * 两条输出都会逐行打码，凭证不会落盘。
 *
 * @param prefix 日志前缀，例如 `[qq-bot]`。
 * @param options 级别、目录、轮转参数等；也可以直接传一个级别字符串。
 * @returns 日志器。
 */
export function createLogger(prefix: string, options: LoggerOptions | LogLevel = {}): Logger {
  const resolved: LoggerOptions = typeof options === "string" ? { level: options } : options
  const level = resolved.level ?? "info"
  const knownSecrets = resolved.knownSecrets ?? []
  const transports: winston.transport[] = []
  const files: FileTransport[] = []

  transports.push(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.errors({ stack: true }),
        consoleFormat(prefix),
        maskFormat(knownSecrets),
      ),
      stderrLevels: ["error"],
    }),
  )

  if (resolved.file !== false) {
    const dir = resolved.dir?.trim() ? resolved.dir : defaultLogDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const transport = new DailyRotateFile({
      dirname: dir,
      filename: FILE_NAME,
      datePattern: "YYYY-MM-DD",
      maxSize: resolved.maxSize ?? DEFAULT_MAX_SIZE,
      maxFiles: resolved.maxFiles ?? DEFAULT_MAX_FILES,
      format: winston.format.combine(
        winston.format.errors({ stack: true }),
        winston.format.json(),
        maskFormat(knownSecrets),
      ),
    })
    const entry: FileTransport = { transport }
    transport.logStream.on("open", (fd: number) => {
      entry.fd = fd
    })
    files.push(entry)
    transports.push(transport)
  }

  const logger = winston.createLogger({
    level,
    format: winston.format((info) => info)(),
    transports,
    exitOnError: false,
  })
  /** 当前级别：热更新时跟着变，缓冲的过滤要与输出一致。 */
  const handle: LoggerHandle = { api: undefined as unknown as Logger, logger, files, level }

  // 传输出错时不能让进程崩掉，也不能让错误本身带着凭证进日志。
  logger.on("error", (error: Error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[${prefix}] 日志写入失败：${maskSecrets(message, { knownSecrets })}`)
  })

  const write = (target: LogLevel, message: string, meta: unknown[]) => {
    // 低于当前级别的日志不进缓冲：面板看到的级别过滤和文件里一致。
    if (LEVEL_ORDER.indexOf(target) < LEVEL_ORDER.indexOf(handle.level)) return
    const details = normalizeMeta(meta)
    pushBuffer(target, message, details, knownSecrets)
    logger.log({
      level: target,
      message,
      ...(details.length > 0 ? { meta: details } : {}),
      timestamp: new Date().toISOString(),
    })
  }

  const api: Logger = {
    debug: (message, ...meta) => write("debug", message, meta),
    info: (message, ...meta) => write("info", message, meta),
    warn: (message, ...meta) => write("warn", message, meta),
    error: (message, ...meta) => write("error", message, meta),
  }
  handle.api = api
  handles.add(handle)
  return api
}

/**
 * 改日志器的最低级别。
 *
 * 日志级别是热字段：面板改完立即生效，不用重启。
 */
export function setLogLevel(target: Logger, level: LogLevel): void {
  const handle = [...handles].find((entry) => entry.api === target)
  if (!handle) return
  handle.level = level
  handle.logger.level = level
}

/** 等传输发出 finish：这时文件流已经把数据交给了操作系统。 */
function waitFinish(transport: DailyRotateFile): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), CLOSE_TIMEOUT_MS)
    unrefTimer(timer)
    transport.once("finish", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * 关闭指定日志器，等文件传输把缓冲写完；不传时关闭全部。
 *
 * 插件卸载时只关自己的日志器，避免接管实例时误关新实例。
 */
export async function closeLogger(target?: Logger): Promise<void> {
  const closing = target ? [...handles].filter((handle) => handle.api === target) : [...handles]
  for (const handle of closing) handles.delete(handle)
  await Promise.all(
    closing.map(async (handle) => {
      const waits = handle.files.map((file) => waitFinish(file.transport))
      handle.logger.close()
      await Promise.all(waits)
    }),
  )
}

/**
 * 把指定日志器刷到磁盘；不传时刷新全部。
 *
 * 文件写入是异步的：等一个事件循环，再把内核缓冲 fsync 一次。
 */
export async function flushLogger(target?: Logger): Promise<void> {
  const targets = target ? [...handles].filter((handle) => handle.api === target) : [...handles]
  for (const handle of targets) {
    for (const file of handle.files) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (file.fd === undefined) continue
      try {
        fsyncSync(file.fd)
      } catch {
        // 文件可能刚好被轮转或关闭，忽略。
      }
    }
  }
}
