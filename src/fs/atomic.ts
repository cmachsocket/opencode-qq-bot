import { lstat, mkdir, open, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import writeFileAtomic from "write-file-atomic"

/**
 * 配置文件的原子写。
 *
 * 临时文件 + fsync + rename：中途失败不会留下半截文件；
 * 写之前把旧内容存成 `.bak`，写坏了还能翻回去。
 * `config.json`、`chat-overrides.json` 与 `tool-profiles.json` 共用这一份实现。
 *
 * 目标必须是普通文件：符号链接一律拒绝写。`write-file-atomic` 会把临时文件
 * rename 到链接指向的真实文件上，链接本身还在，但替换的是别人的 inode；
 * 链接要是被别处种下的，写出去的内容就落到了意料之外的地方。
 */

/** 配置文件权限：只有本人可读写。 */
export const FILE_MODE = 0o600

/** 配置文件所在目录的权限：只有本人可进入。 */
export const DIR_MODE = 0o700

/** 目标是否是指向别处的符号链接。 */
async function isSymlink(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined)
  return info?.isSymbolicLink() ?? false
}

/**
 * 目录 fsync：把 rename 之后的目录项刷盘。
 *
 * 文件本身已经 fsync 过，但没有这一步，断电时目录项可能还没落盘。
 * 不是所有平台都支持对目录 fsync，失败就跳过：这一步只是加固，不是唯一保障。
 */
async function fsyncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, "r")
    await handle.sync()
  } catch {
    // 平台或文件系统不支持对目录 fsync：跳过。
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * 原子写 JSON 文件。
 *
 * 目录按 `0700` 创建，文件按 `0600` 写；备份由调用方单独做。
 *
 * @throws 目标是符号链接时抛错，避免写穿到别处。
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  if (await isSymlink(path)) {
    throw new Error(`拒绝写入符号链接：${path}（请把它换成普通文件再试）`)
  }
  const text = `${JSON.stringify(value, null, 2)}\n`
  await writeFileAtomic(path, text, { mode: FILE_MODE, fsync: true })
  await fsyncDirectory(dirname(path))
}

/**
 * 把当前内容存成 `.bak`。
 *
 * 文件不存在时跳过；`.bak` 是符号链接时拒绝写；其它错误照常抛出，
 * 由调用方决定是记日志还是中断。
 */
export async function backupFile(path: string): Promise<void> {
  const target = `${path}.bak`
  if (await isSymlink(target)) {
    throw new Error(`拒绝写入符号链接：${target}（请把它换成普通文件再试）`)
  }
  try {
    const text = await readFile(path, "utf8")
    await writeFileAtomic(target, text, { mode: FILE_MODE })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
}
