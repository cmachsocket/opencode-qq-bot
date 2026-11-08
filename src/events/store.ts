import { type ChatTarget, targetKey } from "../chat"

/** 待注入通知的缓存参数。 */
export interface NoticeStoreOptions {
  /** 每个聊天最多保留多少条通知。 */
  max?: number
  /** 通知最多等多久（毫秒），超时就不再注入。 */
  ttlMs?: number
  /** 取当前时间，测试时可注入。 */
  now?: () => number
}

/**
 * 按聊天暂存待注入的通知。
 *
 * 通知不自己起一轮，只在下一个轮次的上下文里作为附带信息出现。
 */
export class NoticeStore {
  private readonly max: number
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly pending = new Map<string, { text: string; at: number }[]>()

  constructor(options: NoticeStoreOptions = {}) {
    this.max = options.max ?? 20
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000
    this.now = options.now ?? (() => Date.now())
  }

  /** 暂存一条通知；超出上限时丢掉最旧的。 */
  push(target: ChatTarget, text: string): void {
    const key = targetKey(target)
    const list = this.pending.get(key) ?? []
    list.push({ text, at: this.now() })
    while (list.length > this.max) list.shift()
    this.pending.set(key, list)
  }

  /** 取出并清空某个聊天的待注入通知；过期的直接丢掉。 */
  take(target: ChatTarget): string[] {
    const key = targetKey(target)
    const list = this.pending.get(key)
    if (!list) return []
    this.pending.delete(key)
    const deadline = this.now() - this.ttlMs
    return list.filter((item) => item.at >= deadline).map((item) => item.text)
  }

  /** 当前缓存了多少条通知。 */
  size(target: ChatTarget): number {
    return this.pending.get(targetKey(target))?.length ?? 0
  }
}
