import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import type { Logger } from "./logger"

/**
 * 机器人固定服务的工作目录。
 *
 * 工作目录不再可配置：`config.json` 自己就放在这个目录里，位置固定才不会自举。
 */

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
 * 目录固定在 XDG 数据目录下的工作区，启动时自动创建。
 */
export async function resolveHome(logger: Logger): Promise<BotHome> {
  const directory = defaultHome()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  logger.debug(`机器人工作目录：${directory}`)
  return { directory }
}

/** 展开路径开头的 `~` 或 `~/`，其余原样返回。 */
export function expandTilde(value: string): string {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return join(homedir(), value.slice(2))
  return value
}
