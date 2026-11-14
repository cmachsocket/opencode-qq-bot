import { readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { maskKnownSecrets, SensitiveChecker } from "../sensitive"

/**
 * 角色设定的边界检查。
 *
 * 角色设定文件的内容会一轮一次地进入系统提示词，也就是随每一轮发给模型服务商。
 * 因此这里做两件事：
 *
 * 1. 路径要落在用户声明的允许根之内：先解析符号链接再判断，`souls/link → /etc/passwd`
 *    这种绕过自然失效；
 * 2. 内容要有闸门：大小上限、凭证检测、已知凭证明文掩码。
 *
 * 允许根默认是机器人工作目录，用户可以自己往外加：边界由用户声明一次，
 * 功能不丢，但越界的文件不会随提示词发出去。
 */

/** 角色设定目录名。 */
export const SOUL_DIR = "souls"

/** 角色设定正文的大小上限：64KB。 */
export const MAX_SOUL_BYTES = 64 * 1024

/** 角色设定允许根的来源。 */
export interface SoulGuardOptions {
  /** 机器人工作目录：默认就在允许范围之内。 */
  home: string
  /** 用户额外声明的允许根目录；相对路径按工作目录解析。 */
  allowedPaths?: readonly string[]
}

/** 允许根目录：工作目录 + 用户声明的目录。 */
export function soulRoots(options: SoulGuardOptions): string[] {
  const roots = [resolve(options.home)]
  for (const extra of options.allowedPaths ?? []) {
    const trimmed = extra.trim()
    if (!trimmed) continue
    roots.push(resolve(options.home, trimmed))
  }
  return [...new Set(roots)]
}

/** 目标是否在根目录之下。 */
export function withinRoot(target: string, root: string): boolean {
  if (target === root) return true
  const rel = relative(root, target)
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)
}

/** 词法判断：路径是否在允许根之内（不解析符号链接）。 */
export function withinRoots(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => withinRoot(target, root))
}

/** 路径检查的结果。 */
export type SoulPathCheck =
  { ok: true; path: string } | { ok: false; missing: boolean; reason: string }

/**
 * 检查角色设定文件路径能不能用。
 *
 * 路径先解析成绝对路径，再取真实路径（符号链接按目标判断），最后跟允许根比较：
 * 越界的路径直接拒绝，不给「读到了再判断」的机会。
 * 文件还不存在时按「稍后补齐」处理：目录在允许根之内就留着监听。
 */
export async function checkSoulPath(
  path: string,
  options: SoulGuardOptions,
): Promise<SoulPathCheck> {
  const absolute = resolve(options.home, path)
  const roots = await Promise.all(
    soulRoots(options).map((root) => realpath(root).catch(() => root)),
  )
  let real: string | undefined
  let missing = false
  try {
    real = await realpath(absolute)
  } catch (error) {
    missing = (error as NodeJS.ErrnoException).code === "ENOENT"
  }
  if (!real) {
    // 文件还不存在：所在目录要在允许根之内，否则连监听都不该有。
    const parent = await realpath(dirname(absolute)).catch(() => dirname(absolute))
    if (!withinRoots(parent, roots)) {
      return {
        ok: false,
        missing: false,
        reason: `角色设定文件 ${absolute} 不在允许的目录内，已拒绝加载`,
      }
    }
    if (!missing) {
      return { ok: false, missing: false, reason: `角色设定文件读不到：${absolute}` }
    }
    return { ok: false, missing: true, reason: `角色设定文件不存在：${absolute}` }
  }
  if (!withinRoots(real, roots)) {
    return {
      ok: false,
      missing: false,
      reason: `角色设定文件 ${absolute} 不在允许的目录内，已拒绝加载`,
    }
  }
  const info = await stat(real).catch(() => undefined)
  if (!info) return { ok: false, missing: false, reason: `角色设定文件读不到：${absolute}` }
  if (!info.isFile())
    return { ok: false, missing: false, reason: `角色设定路径不是普通文件：${absolute}` }
  if (info.size > MAX_SOUL_BYTES) {
    return {
      ok: false,
      missing: false,
      reason: `角色设定文件超过 ${MAX_SOUL_BYTES} 字节：${absolute}`,
    }
  }
  return { ok: true, path: real }
}

/** 非文本控制字符；换行与制表符保留。 */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g

/** 角色设定正文与检查结果。 */
export interface SoulContent {
  /** 正文；被拒绝时为空串。 */
  text: string
  /** 被拒绝的原因；为空表示加载成功。 */
  reason?: string
}

/**
 * 读取角色设定正文并过一遍闸门。
 *
 * 命中凭证形状（私钥块、密钥样式的内容、指向凭证文件的路径）就整份拒绝：
 * 人格文件里刚好有私钥，不等于私钥可以发出去。
 * 机器人自己的已知凭证明文不拦，抹成 `[REDACTED]` 即可：面板令牌出现在人格文件里
 * 只会是误抄，不必因此丢掉整份设定。
 */
export async function readSoulContent(
  path: string,
  secrets: readonly string[],
): Promise<SoulContent> {
  let text: string
  try {
    text = await readFile(path, "utf-8")
  } catch (error) {
    return {
      text: "",
      reason: `角色设定读取失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const checker = new SensitiveChecker({
    // 已知凭证明文走掩码，不走拦截，所以这里不把它们交给检测器。
    knownSecrets: [],
    // 内网地址在人格文件里是常见描述，不算凭证：只留真正的密钥类检测器。
    exclude: ["internal_url"],
  })
  const verdict = checker.check(text)
  if (!verdict.allowed) {
    const detectors = verdict.hits.map((hit) => hit.detector).join("、")
    return { text: "", reason: `角色设定里含疑似凭证（${detectors}），已拒绝加载` }
  }
  return { text: maskKnownSecrets(text, secrets).replace(CONTROL, " ") }
}
