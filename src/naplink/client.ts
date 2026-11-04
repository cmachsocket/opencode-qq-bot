import {
  ConnectionState,
  NapLink,
  type GroupMessageEvent,
  type MessageSegment,
  type OneBotApi,
} from "@naplink/naplink"
import type { Logger } from "../logger"
import type { NapcatConfig } from "../config"

/** NapCat 的连接与 API 门面，屏蔽 SDK 细节。 */
export class QQClient {
  private readonly link: NapLink
  private botId: string | undefined

  constructor(
    private readonly config: NapcatConfig,
    private readonly logger: Logger,
  ) {
    this.link = new NapLink({
      connection: {
        url: config.url,
        ...(config.token ? { token: config.token } : {}),
        timeout: 15_000,
      },
      reconnect: {
        enabled: true,
        maxAttempts: 10,
        backoff: { initial: 1000, max: 30_000, multiplier: 2 },
      },
      logging: { level: "warn" },
    })
  }

  get api(): OneBotApi {
    return this.link.api
  }

  get connected(): boolean {
    return this.link.isConnected()
  }

  async connect(): Promise<void> {
    await this.link.connect()
    await this.refreshBotId()
    this.logger.info("NapCat 已连接", this.config.url, this.botId ? `bot=${this.botId}` : "")
  }

  /** 读取机器人自己的 QQ 号。 */
  private async refreshBotId(): Promise<void> {
    const info = (await this.api.getLoginInfo()) as { user_id?: number | string } | undefined
    this.botId = info?.user_id !== undefined ? String(info.user_id) : undefined
  }

  /**
   * 连接 NapCat，失败时只记录日志。
   *
   * 插件加载不应该因为 NapCat 暂时离线而失败，
   * 后续由重连循环或下一次调用补上连接。
   */
  async connectSafe(): Promise<boolean> {
    try {
      await this.connect()
      return true
    } catch (error) {
      this.logger.error("连接 NapCat 失败", error)
      return false
    }
  }

  /** 未连接时尝试补一次连接，成功后刷新机器人 QQ 号。 */
  async ensureConnected(): Promise<boolean> {
    const state = this.link.getState()
    if (state === ConnectionState.CONNECTED) return true
    // NapLink 自己在重连时不插手，避免重复建连。
    if (state === ConnectionState.CONNECTING || state === ConnectionState.RECONNECTING) return false
    try {
      await this.connect()
      return true
    } catch (error) {
      this.logger.warn("重连 NapCat 失败", error)
      return false
    }
  }

  dispose(): void {
    try {
      this.link.dispose()
    } catch (error) {
      this.logger.warn("关闭 NapCat 连接失败", error)
    }
  }

  /** 订阅群消息事件。 */
  onGroupMessage(handler: (event: GroupMessageEvent) => void): void {
    this.link.on("message.group.normal", handler)
  }

  /** 补全消息里媒体段的直链，便于下载图片。 */
  async hydrate(message: MessageSegment[]): Promise<void> {
    try {
      await this.link.hydrateMessage(message)
    } catch (error) {
      this.logger.warn("补全媒体直链失败", error)
    }
  }

  /** 机器人自己的 QQ 号，未连接时返回 undefined。 */
  get selfId(): string | undefined {
    return this.botId
  }
}
