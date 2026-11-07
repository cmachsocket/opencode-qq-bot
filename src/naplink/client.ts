import {
  NapLink,
  type GroupMessageEvent,
  type MessageSegment,
  type OneBotApi,
  type PrivateMessageEvent,
} from "@naplink/naplink"
import type { Logger } from "../logger"
import type { NapcatConfig } from "../config"

const MEDIA_SEGMENT_TYPES = ["image", "video", "record", "audio", "file"] as const

type MediaSegmentType = (typeof MEDIA_SEGMENT_TYPES)[number]

interface MediaSegmentData {
  file?: string
  file_id?: string
  url?: string
}

interface MediaFileLike {
  file?: unknown
  url?: unknown
}

function isMediaSegmentType(type: string): type is MediaSegmentType {
  return (MEDIA_SEGMENT_TYPES as readonly string[]).includes(type)
}

/** 取第一个可下载的 http(s) 直链，忽略本地路径与 base64。 */
export function pickRemoteUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value
  }
  return undefined
}

/**
 * 补全单个媒体段的远程直链。
 *
 * NapCat 同时返回本地路径（`file`）和 CDN 直链（`url`），SDK 自带的补全逻辑
 * 会优先选用本地路径，导致插件无法下载。这里只写入 `url`，且优先使用 http(s) 地址。
 */
export async function hydrateSegment(
  api: OneBotApi,
  segment: MessageSegment,
  logger: Logger,
): Promise<void> {
  if (!isMediaSegmentType(segment.type)) return
  const data = segment.data as MediaSegmentData
  // 已有可用的远程直链时不要覆盖。
  if (pickRemoteUrl(data.url)) return
  const fileId = data.file ?? data.file_id
  if (typeof fileId !== "string" || fileId.length === 0) return
  if (/^(file|base64|data):/i.test(fileId)) return

  try {
    const file = (await api.getFile(fileId)) as MediaFileLike | undefined
    const direct = pickRemoteUrl(file?.url, file?.file)
    if (direct) {
      data.url = direct
      return
    }
    if (segment.type === "image") {
      const image = (await api.getImage(fileId)) as MediaFileLike | undefined
      const imageUrl = pickRemoteUrl(image?.url, image?.file)
      if (imageUrl) data.url = imageUrl
    } else if (segment.type === "record" || segment.type === "audio") {
      const record = (await api.getRecord(fileId, "mp3")) as MediaFileLike | undefined
      const recordUrl = pickRemoteUrl(record?.url, record?.file)
      if (recordUrl) data.url = recordUrl
    }
  } catch (error) {
    logger.debug(`补全媒体直链失败 type=${segment.type} file=${fileId}`, error)
  }
}

/** 补全一条消息里所有媒体段的远程直链。 */
export async function hydrateMedia(
  api: OneBotApi,
  message: MessageSegment[],
  logger: Logger,
): Promise<void> {
  if (!Array.isArray(message)) return
  await Promise.all(message.map((segment) => hydrateSegment(api, segment, logger)))
}

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

  /**
   * 调用 SDK 类型里没有声明的 OneBot 动作。
   *
   * 收藏表情相关的动作（`fetch_custom_face_detail`、`set_custom_face_desc`）
   * 不在 naplink 的类型表里，只能这样透传。
   */
  callApi<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.link.callApi<T>(method, params)
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

  /** 机器人自己的 QQ 号，未连接时返回 undefined。 */
  get selfId(): string | undefined {
    return this.botId
  }
}
