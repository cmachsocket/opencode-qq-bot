import {
  NapLink,
  type GroupMessageEvent,
  type MessageSegment,
  type OneBotApi,
  type PrivateMessageEvent,
} from "@naplink/naplink"
import type { Logger } from "../logger"
import type { NapcatConfig } from "../config"

/** NapCat 的连接与 API 门面，屏蔽 SDK 细节。 */
export class QQClient {
  private readonly link: NapLink
  private botId: string | undefined
  private botIdRequest: Promise<void> | undefined

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
        maxAttempts: Number.POSITIVE_INFINITY,
        backoff: { initial: 1000, max: 30_000, multiplier: 2 },
      },
      logging: { level: "info", logger },
    })
    // 每次（重）连成功都刷新机器人 QQ 号，自动重连后 selfId 依然可用。
    this.link.on("connect", () => {
      void this.refreshBotId().then(() => {
        this.logger.info("NapCat 已连接", this.config.url, this.botId ? `bot=${this.botId}` : "")
      })
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
  }

  /** 读取机器人自己的 QQ 号，并发调用时复用同一个请求。 */
  private refreshBotId(): Promise<void> {
    this.botIdRequest ??= this.loadBotId().finally(() => {
      this.botIdRequest = undefined
    })
    return this.botIdRequest
  }

  private async loadBotId(): Promise<void> {
    try {
      const info = (await this.api.getLoginInfo()) as { user_id?: number | string } | undefined
      this.botId = info?.user_id !== undefined ? String(info.user_id) : undefined
    } catch (error) {
      this.logger.warn("读取机器人 QQ 号失败", error)
    }
  }

  /**
   * 连接 NapCat，失败时只记录日志。
   *
   * 后续重连由 NapLink 自己负责，插件加载不应该因为 NapCat 暂时离线而失败。
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

  /** 订阅私聊消息事件（好友、临时会话等）。 */
  onPrivateMessage(handler: (event: PrivateMessageEvent) => void): void {
    this.link.on("message.private", handler)
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
