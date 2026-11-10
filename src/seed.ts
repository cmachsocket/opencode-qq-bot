import { existsSync } from "node:fs"
import { copyFile, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { Logger } from "./logger"

/** 随包分发文件所在目录：种子文件只从这里取。 */
export const packageRoot = resolve(import.meta.dirname, "..")

/**
 * 把随包分发的模板复制到工作目录。
 *
 * 目标已存在时原样保留：用户的改动不会被升级或重启覆盖。
 *
 * @returns 是否真的复制了。
 */
export async function seedFile(
  source: string,
  destination: string,
  logger: Logger,
): Promise<boolean> {
  if (existsSync(destination)) return false
  try {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await copyFile(source, destination)
    logger.info(`已放到工作目录：${destination}`)
    return true
  } catch (error) {
    logger.warn(`复制 ${source} 失败`, error)
    return false
  }
}
