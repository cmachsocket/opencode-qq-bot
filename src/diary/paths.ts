import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

/** 目录的真实路径；目录还不存在时退回解析后的词法路径。 */
export async function realDir(dir: string): Promise<string> {
  try {
    return await realpath(dir)
  } catch {
    return resolve(dir)
  }
}

/** 已存在路径的真实路径；不存在或读不到时返回 undefined。 */
export async function realExisting(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

/** 目标是否在根目录之内，按目录边界判定，`/data/a` 不会命中 `/data/ab`。 */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  if (rel === "") return true
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
