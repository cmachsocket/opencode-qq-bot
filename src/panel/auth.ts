import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * 面板鉴权：单令牌 + 会话 Cookie。
 *
 * 面板是单用户本地工具：一个令牌换一张会话 Cookie 就够了。
 */

/** 会话 Cookie 的名字。 */
export const SESSION_COOKIE = "qqbot_session"

/** 令牌哈希。 */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest()
}

/** 令牌与会话管理。 */
export class PanelAuth {
  /** 令牌哈希：内存里不留明文。 */
  private tokenHash: Buffer
  /** 已签发的会话 id。 */
  private readonly sessions = new Set<string>()

  constructor(token: string) {
    this.tokenHash = digest(token)
  }

  /**
   * 令牌是否正确。
   *
   * 比较等长的 sha256 哈希，恒定时间，不泄露长度以外的信息。
   */
  matches(candidate: string): boolean {
    if (typeof candidate !== "string" || candidate.length === 0) return false
    return timingSafeEqual(this.tokenHash, digest(candidate))
  }

  /** 签发一个会话 id。 */
  issue(): string {
    const id = randomBytes(24).toString("hex")
    this.sessions.add(id)
    return id
  }

  /** 会话是否有效。 */
  valid(session: string | undefined): boolean {
    if (typeof session !== "string" || session.length === 0) return false
    return this.sessions.has(session)
  }

  /**
   * 更换令牌。
   *
   * 旧令牌与所有已签发的会话立刻作废。
   */
  rotate(token: string): void {
    this.tokenHash = digest(token)
    this.sessions.clear()
  }

  /** 作废全部会话。 */
  clear(): void {
    this.sessions.clear()
  }
}
