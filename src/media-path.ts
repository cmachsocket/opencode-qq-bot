import { lookup } from "node:dns/promises"
import { realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"
import ipaddr from "ipaddr.js"
import { expandTilde } from "./home"
import { ALLOWED_PORTS } from "./safe-fetch"

/**
 * 媒体目录：`$XDG_STATE_HOME/opencode-qq-bot/media`。
 *
 * 未设置 `XDG_STATE_HOME` 时用 `~/.local/state/opencode-qq-bot/media`。
 */
export function defaultMediaDir(): string {
  const state = process.env.XDG_STATE_HOME?.trim()
  const base = state && isAbsolute(state) ? state : join(homedir(), ".local", "state")
  return join(base, "opencode-qq-bot", "media")
}

/** 出站媒体的路径策略。 */
export interface MediaPolicy {
  /** 机器人工作目录：相对路径按它解析。 */
  workspace: string
  /** 允许发送媒体的目录（绝对路径或 `~/` 开头）。 */
  allowedDirs: string[]
}

/** 媒体被策略拒绝时抛出，错误说明直接回给模型。 */
export class MediaPolicyError extends Error {}

/** 出站媒体的处理计划。 */
export type MediaPlan = { kind: "local"; path: string } | { kind: "remote"; url: URL }

/** 展开 `~` 并去掉首尾空白。 */
function expand(value: string): string {
  return expandTilde(value.trim())
}

/**
 * 判断路径是否位于目录之内。
 *
 * 按目录边界比较：`/data/qq-bot` 不会命中 `/data/qq-bot-secret`。
 */
function contains(dir: string, target: string): boolean {
  if (dir === target) return true
  const prefix = dir.endsWith(sep) ? dir : dir + sep
  return target.startsWith(prefix)
}

/**
 * 判断一个 IP 是不是公网地址。
 *
 * 规则与 `request-filtering-agent` 一致：只有 `unicast` 段算公网，
 * 回环、私网、CGNAT、链路本地、组播、IPv4-mapped、6to4 等一律不算。
 */
function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.parse(address).range() === "unicast"
  } catch {
    return false
  }
}

/**
 * 出站媒体的路径与地址把关。
 *
 * 本地路径只允许机器人工作目录、媒体目录和配置里显式放开的目录；
 * 远端地址要求解析出的地址都是公网，再交给 NapCat 自己去拉。
 */
export class OutboundMedia {
  constructor(private readonly policy: MediaPolicy) {}

  /**
   * 检查媒体引用。
   *
   * 本地路径在这里就判定白名单，判定不过直接抛错，不占用发送额度。
   */
  async check(file: string): Promise<MediaPlan> {
    const value = expand(file)
    if (value.startsWith("http://") || value.startsWith("https://")) {
      let url: URL
      try {
        url = new URL(value)
      } catch {
        throw new MediaPolicyError(`媒体地址无效：${file}`)
      }
      await this.checkRemote(url)
      return { kind: "remote", url }
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      throw new MediaPolicyError(`不支持的媒体地址：${file}`)
    }
    return { kind: "local", path: await this.resolveLocal(value) }
  }

  /** 按计划拿到可以交给 NapCat 的文件字段。 */
  materialize(plan: MediaPlan): string {
    return plan.kind === "local" ? plan.path : plan.url.href
  }

  /**
   * 判定远端地址能不能用。
   *
   * 只放行常见网页端口；域名解析出来的每一个地址都必须是公网地址，
   * 否则拒绝——不给 NapCat 留去拉内网地址的机会。
   *
   * 注意：实际下载由 NapCat 完成，它会自己再解析一次 DNS，
   * 所以这里挡的是「地址本身指向内网」，挡不住 DNS 重绑定。
   */
  private async checkRemote(url: URL): Promise<void> {
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
    if (!ALLOWED_PORTS.includes(port)) {
      throw new MediaPolicyError(`媒体地址的端口不在白名单内：${port}`)
    }
    const host = url.hostname.replace(/^\[|\]$/g, "")
    const addresses = await resolveAddresses(host)
    if (addresses.length === 0) {
      throw new MediaPolicyError(`媒体地址解析不出 IP：${url.hostname}`)
    }
    for (const address of addresses) {
      if (!isPublicAddress(address)) {
        throw new MediaPolicyError(`媒体地址指向内网，不允许发送：${url.hostname}（${address}）`)
      }
    }
  }

  /**
   * 判定本地路径是否在允许的目录内。
   *
   * 展开 `~`、相对路径按工作目录解析，再取真实路径判定：
   * 目录内的软链接指向目录外时同样拒绝，避免软链接绕过。
   */
  private async resolveLocal(file: string): Promise<string> {
    const expanded = expand(file)
    const lexical = isAbsolute(expanded) ? expanded : resolve(this.policy.workspace, expanded)
    let real: string
    try {
      real = await realpath(lexical)
    } catch {
      throw new MediaPolicyError(`媒体文件不存在或无法读取：${file}`)
    }
    const info = await stat(real)
    if (!info.isFile()) {
      throw new MediaPolicyError(`媒体路径不是普通文件：${file}`)
    }
    const dirs = await this.allowedDirs()
    const inLexical = dirs.some((dir) => contains(dir.lexical, lexical))
    const inReal = dirs.some((dir) => contains(dir.real, real) || contains(dir.lexical, real))
    if (!inLexical || !inReal) {
      const allowed = dirs.map((dir) => dir.lexical).join("、")
      throw new MediaPolicyError(`媒体文件不在允许的目录内：${file}（允许：${allowed || "无"}）`)
    }
    return real
  }

  /** 允许的目录：词法路径与真实路径各一份，软链接目录也能命中。 */
  private async allowedDirs(): Promise<{ lexical: string; real: string }[]> {
    const dirs: { lexical: string; real: string }[] = []
    for (const dir of this.policy.allowedDirs) {
      const expanded = expand(dir)
      if (!expanded) continue
      const lexical = isAbsolute(expanded) ? expanded : resolve(this.policy.workspace, expanded)
      let real = lexical
      try {
        real = await realpath(lexical)
      } catch {
        // 目录还不存在时先按词法路径处理。
      }
      dirs.push({ lexical, real })
    }
    return dirs
  }
}

/** 解析主机名，返回全部地址；本身就是 IP 时直接返回。 */
async function resolveAddresses(host: string): Promise<string[]> {
  if (ipaddr.isValid(host)) return [host]
  try {
    const found = await lookup(host, { all: true, verbatim: true })
    return found.map((entry) => entry.address)
  } catch {
    return []
  }
}
