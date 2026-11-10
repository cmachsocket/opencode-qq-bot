import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, normalize } from "node:path"
import type { Logger } from "./logger"

/** 机器人固定服务的工作目录。 */
export interface BotHome {
  /** 会话统一所在的绝对路径。 */
  directory: string
}

/** 默认工作目录：`$XDG_DATA_HOME/opencode-qq-bot/workspace`。 */
export function defaultHome(): string {
  const data = process.env.XDG_DATA_HOME
  const base = data && isAbsolute(data) ? data : join(homedir(), ".local", "share")
  return join(base, "opencode-qq-bot", "workspace")
}

/**
 * 解析机器人工作目录并确保它存在。
 *
 * 配置项优先；未配置时使用默认的 XDG 工作区，避免会话工作目录随加载插件的项目漂移。
 */
export async function resolveHome(
  configured: string | undefined,
  logger: Logger,
): Promise<BotHome> {
  const directory = configured ? expand(configured, logger) : defaultHome()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return { directory }
}

/** 展开路径开头的 `~` 或 `~/`，其余原样返回。 */
export function expandTilde(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return join(homedir(), value.slice(2))
  return value
}

function expand(configured: string, logger: Logger): string {
  const expanded = expandTilde(configured)
  if (!isAbsolute(expanded)) {
    logger.warn("机器人工作目录必须是绝对路径，已回退到默认目录", configured)
    return defaultHome()
  }
  return normalize(expanded)
}
