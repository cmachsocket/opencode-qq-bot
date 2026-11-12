import { applyHotFields, resolveConfig, type ConfigWarning, type QQBotConfig } from "../config"
import { CONFIG_FIELDS } from "../config/fields"
import type { Logger } from "../logger"
import type { ConfigPatch, ConfigStore } from "./store"

/**
 * 生效中的配置：文件内容、内存配置与热更新都归它管。
 *
 * 配置的唯一来源是 `config.json`：外部改了文件会被监听到并热更新，
 * 面板保存也走同一条路径，落盘的就是权威值。
 */

/** 配置变化的回调。 */
export type ConfigListener = (config: QQBotConfig, raw: Record<string, unknown>) => void

/** 配置控制器的依赖。 */
export interface ConfigControllerOptions {
  /** 配置文件读写器。 */
  store: ConfigStore
  /** `opencode.json` 里的 agent。 */
  agent?: string
  /** 告警回调。 */
  warn?: ConfigWarning
  /** 日志器；没有单独的告警回调时把告警写进日志。 */
  logger?: Logger
}

/** 保存后的结果。 */
export interface ConfigUpdateResult {
  /** 更新后的生效配置。 */
  config: QQBotConfig
  /** 这次改动里需要重启才能生效的字段路径。 */
  restartRequired: string[]
}

export class ConfigController {
  /** 配置文件里的原始内容。 */
  private raw: Record<string, unknown> = {}
  /** 生效中的配置对象：热更新只改它的叶子值，对象身份保持不变。 */
  private config: QQBotConfig | undefined
  private readonly listeners = new Set<ConfigListener>()
  private stopWatching: (() => void) | undefined

  constructor(private readonly options: ConfigControllerOptions) {}

  /** 输出一条配置告警：优先用注入的回调，否则写日志。 */
  private warn(message: string): void {
    if (this.options.warn) {
      this.options.warn(message)
      return
    }
    this.options.logger?.warn(message)
  }

  /** 生效中的配置；尚未加载时是 undefined。 */
  get current(): QQBotConfig | undefined {
    return this.config
  }

  /** 配置文件里的原始内容。 */
  get file(): Record<string, unknown> {
    return this.raw
  }

  /**
   * 读取配置文件并解析成生效配置。
   *
   * @throws 配置文件不存在或内容非法时抛出：配置来源只有一个，缺文件不能静默按默认值跑。
   */
  async load(): Promise<QQBotConfig> {
    this.raw = await this.options.store.read()
    this.config = this.resolve(this.raw)
    return this.config
  }

  /** 解析文件内容；非法值告警并回退默认值。 */
  private resolve(raw: Record<string, unknown>): QQBotConfig {
    return resolveConfig(raw, this.options.agent, (message) => this.warn(message))
  }

  /**
   * 应用稀疏补丁并落盘。
   *
   * 只改动补丁里出现的路径；值为 `null` 表示删掉这个键，回到默认值。
   * 落盘的是权威值，下次启动仍然生效。
   */
  async applyPatch(patch: ConfigPatch): Promise<ConfigUpdateResult> {
    const live = this.config
    if (!live) throw new Error("配置尚未加载")
    const raw = await this.options.store.patch(patch)
    await this.options.store.write(raw)
    this.raw = raw
    const next = this.resolve(raw)
    applyHotFields(live, next)
    this.config = live
    this.notify()
    return {
      config: live,
      restartRequired: Object.keys(patch).filter((path) => !isHotField(path)),
    }
  }

  /**
   * 监听配置文件的外部改动。
   *
   * 改动合法就热更新并通知；不合法只告警，继续用上一份配置。
   */
  async startWatching(): Promise<void> {
    if (this.stopWatching) return
    this.stopWatching = await this.options.store.watch((raw) => {
      if (JSON.stringify(raw) === JSON.stringify(this.raw)) return
      const live = this.config
      if (!live) return
      let next: QQBotConfig
      try {
        next = this.resolve(raw)
      } catch (error) {
        this.warn(
          `配置文件改动后无法解析，继续沿用上一份配置：${error instanceof Error ? error.message : String(error)}`,
        )
        return
      }
      this.raw = raw
      applyHotFields(live, next)
      this.config = live
      this.notify()
    })
  }

  /** 停止监听。 */
  stop(): void {
    this.stopWatching?.()
    this.stopWatching = undefined
  }

  /** 订阅配置变化。 */
  onChange(listener: ConfigListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 通知订阅者。 */
  private notify(): void {
    const live = this.config
    if (!live) return
    for (const listener of this.listeners) listener(live, this.raw)
  }
}

/** 字段是不是热更新：热字段保存后立即生效，不必重启。 */
export function isHotField(path: string): boolean {
  return CONFIG_FIELDS.find((field) => field.path === path)?.hot === true
}
