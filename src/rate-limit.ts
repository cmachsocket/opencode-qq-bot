import { Mutex } from "async-mutex"
import { type ChatTarget, targetKey } from "./chat"
import type { RateLimitConfig } from "./config"

/** 一分钟的毫秒数。 */
const MINUTE_MS = 60_000
/** 一小时的毫秒数。 */
const HOUR_MS = 60 * MINUTE_MS

/** 限流判定结果。 */
export interface RateLimitVerdict {
  /** 是否放行这次发送。 */
  allowed: boolean
  /** 拒绝原因，直接写给模型看；放行时为空串。 */
  reason: string
  /** 为了放行这次发送实际等待的毫秒数。 */
  waitedMs: number
}

/** 一次出站发送的记录。 */
interface SendRecord {
  /** 发送时间（毫秒）。 */
  at: number
  /** 所属发送操作；同一次工具调用拆出的多段共用一个 id。 */
  operation?: string
}

export interface SendRateLimiterOptions {
  /** 取当前时间（毫秒），测试时可注入。 */
  now?: () => number
  /** 等待一段时间，测试时可注入。 */
  sleep?: (ms: number) => Promise<void>
}

/** 模型驱动的出站消息按目标计数：同一个群共用一份额度。 */
export function modelSendScope(target: ChatTarget): string {
  return targetKey(target)
}

/**
 * 插件自己生成的出站消息单独计数。
 *
 * 命令结果、任务进度不是模型刷屏，不该占用模型回复的额度，
 * 但同样要和其它出站消息隔开一点时间。
 */
export function pluginSendScope(target: ChatTarget): string {
  return `${targetKey(target)}#plugin`
}

/**
 * 出站消息的速率限制。
 *
 * 每个目标单独计数。硬上限（每分钟 / 每小时）超出时直接拒绝这次发送，
 * 让模型立刻停下而不是把群刷爆；相邻两次发送间隔不足时先等一等，
 * 攒成一阵发出去也不会连成一片。
 *
 * 计数与限流状态只存在内存里：插件重启后重新开始计数，
 * 短窗口的计数本来也不该跨重启保留。
 */
export class SendRateLimiter {
  /** 每个目标最近的发送记录。 */
  private readonly records = new Map<string, SendRecord[]>()
  /** 每个目标的互斥锁，同一目标的并发发送串行判定。 */
  private readonly locks = new Map<string, Mutex>()

  constructor(
    private readonly config: RateLimitConfig,
    private readonly options: SendRateLimiterOptions = {},
  ) {}

  private get currentTime(): number {
    return (this.options.now ?? Date.now)()
  }

  private get wait(): (ms: number) => Promise<void> {
    return this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  private lock(scope: string): Mutex {
    let lock = this.locks.get(scope)
    if (!lock) {
      lock = new Mutex()
      this.locks.set(scope, lock)
    }
    return lock
  }

  /** 取目标最近一小时的发送记录，顺手丢掉过期的那几条。 */
  private recent(scope: string, now: number): SendRecord[] {
    const records = this.records.get(scope) ?? []
    const kept = records.filter((record) => now - record.at < HOUR_MS)
    if (kept.length !== records.length) this.records.set(scope, kept)
    return kept
  }

  /**
   * 申请一次发送许可。
   *
   * @param scope 计数维度，通常是目标键（`group:123`）。
   * @param operation 同一次工具调用拆出的多段共用一个 id：段与段之间不再额外等待。
   * @returns 放行时 `allowed` 为真；被硬上限拦下时带上原因与等待建议。
   */
  async acquire(scope: string, operation?: string): Promise<RateLimitVerdict> {
    return await this.lock(scope).runExclusive(() => this.admit(scope, operation, true))
  }

  /**
   * 只做节奏控制，永不拒绝。
   *
   * 插件自己生成的消息（命令结果、任务进度）走这里：
   * 它们不是模型刷屏，但同样不该连成一片发出去。
   */
  async pace(scope: string, operation?: string): Promise<void> {
    await this.lock(scope).runExclusive(() => this.admit(scope, operation, false))
  }

  /** 判定并记账一次发送。 */
  private async admit(
    scope: string,
    operation: string | undefined,
    enforce: boolean,
  ): Promise<RateLimitVerdict> {
    const now = this.currentTime
    const records = this.recent(scope, now)
    if (enforce) {
      const minute = records.filter((record) => now - record.at < MINUTE_MS).length
      if (this.config.maxPerMinute > 0 && minute >= this.config.maxPerMinute) {
        return {
          allowed: false,
          reason: `发送频率超限：本分钟已发出 ${minute} 条，最多为每分钟 ${this.config.maxPerMinute} 条。请停止发送并结束本轮。`,
          waitedMs: 0,
        }
      }
      if (this.config.maxPerHour > 0 && records.length >= this.config.maxPerHour) {
        return {
          allowed: false,
          reason: `发送频率超限：本小时已发出 ${records.length} 条，最多为每小时 ${this.config.maxPerHour} 条。请停止发送并结束本轮。`,
          waitedMs: 0,
        }
      }
    }

    const waitedMs = this.gapDelay(records, now, operation)
    if (waitedMs > 0) await this.wait(waitedMs)
    this.records.set(scope, [
      ...records,
      { at: this.currentTime, ...(operation ? { operation } : {}) },
    ])
    return { allowed: true, reason: "", waitedMs }
  }

  /** 距离上一次发送还差多久；同一次操作的多段之间不再等待。 */
  private gapDelay(records: SendRecord[], now: number, operation?: string): number {
    const gap = this.config.minGapMs
    if (gap <= 0) return 0
    const last = records[records.length - 1]
    if (!last) return 0
    if (operation !== undefined && last.operation === operation) return 0
    return Math.max(0, gap - (now - last.at))
  }
}
