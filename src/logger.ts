export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(message: string, ...meta: unknown[]): void
  info(message: string, ...meta: unknown[]): void
  warn(message: string, ...meta: unknown[]): void
  error(message: string, ...meta: unknown[]): void
}

/** 创建带前缀的日志器，插件运行在 OpenCode 服务端，直接写 stdout/stderr。 */
export function createLogger(prefix: string, level: LogLevel = "info"): Logger {
  const threshold = LEVEL_ORDER[level]
  const write = (lvl: LogLevel, stream: "log" | "error", message: string, meta: unknown[]) => {
    if (LEVEL_ORDER[lvl] < threshold) return
    const stamp = new Date().toISOString()
    const line = `[${stamp}] ${lvl.toUpperCase()} ${prefix} ${message}`
    if (meta.length > 0) console[stream](line, ...meta)
    else console[stream](line)
  }

  return {
    debug: (message, ...meta) => write("debug", "log", message, meta),
    info: (message, ...meta) => write("info", "log", message, meta),
    warn: (message, ...meta) => write("warn", "log", message, meta),
    error: (message, ...meta) => write("error", "error", message, meta),
  }
}
