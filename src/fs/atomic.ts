import { mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import writeFileAtomic from "write-file-atomic"

/**
 * 配置文件的原子写。
 *
 * 临时文件 + fsync + rename：中途失败不会留下半截文件；
 * 写之前把旧内容存成 `.bak`，写坏了还能翻回去。
 * `config.json`、`chat-overrides.json` 与 `tool-profiles.json` 共用这一份实现。
 */

/** 配置文件权限：只有本人可读写。 */
export const FILE_MODE = 0o600

/** 配置文件所在目录的权限：只有本人可进入。 */
export const DIR_MODE = 0o700

/**
 * 原子写 JSON 文件。
 *
 * 目录按 `0700` 创建，文件按 `0600` 写；备份由调用方单独做。
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  const text = `${JSON.stringify(value, null, 2)}\n`
  await writeFileAtomic(path, text, { mode: FILE_MODE, fsync: true })
}

/**
 * 把当前内容存成 `.bak`。
 *
 * 文件不存在时跳过；其它错误照常抛出，由调用方决定是记日志还是中断。
 */
export async function backupFile(path: string): Promise<void> {
  try {
    const text = await readFile(path, "utf8")
    await writeFileAtomic(`${path}.bak`, text, { mode: FILE_MODE })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}
