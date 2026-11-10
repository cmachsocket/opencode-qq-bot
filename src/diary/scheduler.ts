import { Mutex } from "async-mutex"
import { allowedTargets, isTargetAllowed } from "../access"
import { type ChatTarget, parseTargetKey, targetKey, targetLabel } from "../chat"
import type { QQBotConfig } from "../config"
import type { Logger } from "../logger"
import type { OutboundMedia } from "../media-path"
import type { QQClient } from "../naplink/client"
import type { SendRateLimiter } from "../rate-limit"
import type { SensitiveChecker } from "../sensitive"
import { sendFileMessage, sendPlainMessage } from "../tools/qq"
import type { DiaryCollector } from "./collector"
import { dateKey } from "./format"
import type { DiaryStore } from "./store"
import type { DiarySummarizer } from "./summary"

/** 日记调度器的依赖。 */
export interface DiarySchedulerDeps {
  config: QQBotConfig
  logger: Logger
  client: QQClient
  limiter: SendRateLimiter
  /** 出站媒体的路径把关，发送日记文件时用。 */
  outbound: OutboundMedia
  /** 出站敏感信息检查。 */
  sensitive: SensitiveChecker
  /** 日记读写。 */
  store: DiaryStore
  /** 素材读取。 */
  collector: DiaryCollector
  /** 自动总结。 */
  summarizer: DiarySummarizer
}

/**
 * 时刻转成当天第几分钟。
 *
 * 格式不对时按 0 处理：调度器会因此认为还没到点，不会误触发。
 */
export function minutesOfDay(time: string): number {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim())
  if (!match) return 0
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0
  return hour * 60 + minute
}

/**
 * 定时生成当天的日记并推送。
 *
 * 定时器随插件一起卸载：要保证定时跑，需要
 * `experimental.location_idle_timeout: false`。
 */
export class DiaryScheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  /** 整个调度只允许一个任务在跑。 */
  private readonly mutex = new Mutex()
  /** 正在生成中的聊天，同一聊天同一时刻只跑一个任务。 */
  private readonly running = new Set<string>()

  constructor(private readonly deps: DiarySchedulerDeps) {}

  /** 开始轮询。 */
  start(): void {
    if (this.timer) return
    const seconds = Math.max(60, this.deps.config.diary.tickSeconds)
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => this.deps.logger.error("日记调度失败", error))
    }, seconds * 1000)
    const handle = this.timer as { unref?: () => void }
    handle.unref?.()
    this.deps.logger.info(`日记调度已启动，轮询间隔 ${seconds} 秒`)
  }

  /** 停止轮询。 */
  async dispose(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * 跑一轮调度。
   *
   * 已经过了总结时刻、该聊天今天还没有自动日记时才动手；
   * 当天没有素材就跳过，不调用模型也不推送。
   */
  async tick(now: Date = new Date()): Promise<void> {
    if (!this.deps.config.diary.enabled) return
    if (this.mutex.isLocked()) return
    await this.mutex.runExclusive(async () => {
      // 素材是中间产物，过期就清掉；日记成品不动。
      await this.deps.collector.cleanup(this.deps.config.diary.retentionDays)
      const target = minutesOfDay(this.deps.config.diary.summaryTime)
      const current = now.getHours() * 60 + now.getMinutes()
      if (current < target) return
      const date = dateKey(now)
      for (const chat of this.targets()) {
        await this.runFor(chat, date)
      }
    })
  }

  /** 本轮要处理的目标聊天。 */
  private targets(): ChatTarget[] {
    const access = this.deps.config.access
    const owner = this.deps.config.ownerQQ
    const configured = this.deps.config.diary.summaryTargets
      .map((value) => parseTargetKey(value))
      .filter((value): value is ChatTarget => Boolean(value))
    if (configured.length > 0) {
      // 明确配了目标就只认这些，但仍然要过准入判定。
      return configured.filter((chat) => isTargetAllowed(access, chat, owner))
    }
    return allowedTargets(access, owner)
  }

  /** 为一个聊天生成当天的日记。 */
  private async runFor(chat: ChatTarget, date: string): Promise<void> {
    const key = targetKey(chat)
    if (this.running.has(key)) return
    if (await this.deps.store.hasAuto(key, date)) return
    if (!(await this.deps.collector.has(key, date))) return
    this.running.add(key)
    try {
      const title = await this.deps.summarizer.summarize(key, date)
      if (!title) return
      await this.push(chat, date)
    } catch (error) {
      this.deps.logger.error(`${targetLabel(chat)} 的日记生成失败`, error)
    } finally {
      this.running.delete(key)
    }
  }

  /** 按配置推送日记产物。 */
  private async push(chat: ChatTarget, date: string): Promise<void> {
    const mode = this.deps.config.diary.push
    if (mode === "none") return
    const file = this.deps.store.filePath(targetKey(chat), date)
    const owner = this.deps.config.ownerQQ
    const toOwner = mode === "owner"
    let target: ChatTarget = chat
    if (toOwner) {
      if (owner === undefined) {
        this.deps.logger.warn("没有配置 ownerQQ，日记生成后不推送")
        return
      }
      target = { kind: "private", id: owner }
    }
    const text = toOwner
      ? `${targetLabel(chat)} ${date} 的日记已生成\n文件：${file}`
      : `${date} 的日记已生成`
    // 推送走插件自己的通道，不经过模型侧的出站检查，这里自己过一遍。
    const verdict = this.deps.sensitive.check(text)
    if (!verdict.allowed) {
      this.deps.logger.warn(`${targetLabel(target)} 的日记推送包含敏感信息，已拦截`)
      return
    }
    await sendFileMessage(this.deps.client, target, file, {
      name: `日记-${date}.md`,
      limiter: this.deps.limiter,
      outbound: this.deps.outbound,
      sensitive: this.deps.sensitive,
    })
    await sendPlainMessage(this.deps.client, target, text, { limiter: this.deps.limiter })
  }
}
