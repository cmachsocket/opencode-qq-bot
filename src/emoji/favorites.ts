import { Mutex } from "async-mutex"
import type { Logger } from "../logger"
import { sanitizeUntrustedText } from "../model-view"

/**
 * NapCat 收藏表情（自定义表情）的详情。
 *
 * 只声明插件用到的字段，其余字段保持原样透传。
 */
export interface CustomFace {
  /** 表情所属的 QQ 号。 */
  uin?: number | string
  /** 表情编号（账号内唯一），写标签和发送时都用它。 */
  emoId?: number | string
  /** 资源 ID，写标签时用。 */
  resId?: string
  /** CDN 直链，发送收藏表情时用。 */
  url?: string
  /** 图片 md5，写标签时 NapCat 会校验。 */
  md5?: string
  /** 自定义标签；标签只存在 NapCat 的这个字段里。 */
  desc?: string
  [key: string]: unknown
}

/** OneBot 动作调用器。 */
export type OneBotCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

/** 收藏表情列表的缓存时长。 */
export const FAVORITE_CACHE_TTL_MS = 30_000
/** 一次拉取的收藏表情数量。 */
export const FAVORITE_FETCH_COUNT = 48
/** 收藏表情（KCUSTOM）图片段的 sub_type。 */
export const CUSTOM_FACE_SUB_TYPE = 1

/** 读取收藏表情上的标签，没有标签时返回空字符串。 */
export function faceTag(face: CustomFace): string {
  // desc 由表情主人撰写，属于不受信任文本，进提示词前先净化。
  return typeof face.desc === "string" ? sanitizeUntrustedText(face.desc).trim() : ""
}

/** 判断一个图片段是不是收藏表情。 */
export function isCustomFaceImage(data: { sub_type?: unknown }): boolean {
  const subType = data.sub_type
  return subType === CUSTOM_FACE_SUB_TYPE || subType === String(CUSTOM_FACE_SUB_TYPE)
}

/**
 * 收藏表情的编号与数据的对应关系。
 *
 * 编号由插件自己维护（见 `favorite-index.ts`），与 NapCat 的 `emo_id` 无关。
 */
export interface FavoriteRow {
  /** 插件维护的稳定编号，从 1 开始。 */
  id: number
  /** 对应的收藏表情。 */
  face: CustomFace
  /** 收藏表情当前的标签。 */
  tag: string
}

/**
 * 列出收藏表情的编号与标签。
 *
 * 编号就是发送收藏表情时用的 id。
 */
export function formatFavoriteList(rows: readonly FavoriteRow[]): string {
  if (rows.length === 0) return "没有读取到收藏表情。"
  const lines = rows.map((row) => `${row.id}. ${row.tag || "（未标注）"}`)
  return [`收藏表情（编号即发送用的 id，共 ${rows.length} 个）`, ...lines].join("\n")
}

/** 把收藏表情的编号列成一行，用于报错时提示可用编号。 */
export function formatFavoriteIds(rows: readonly FavoriteRow[]): string {
  const items = rows.map((row) => (row.tag ? `${row.id}(${row.tag})` : `${row.id}`))
  return items.length > 0 ? items.join(", ") : "（没有收藏表情）"
}

/**
 * 收藏表情的读写入口。
 *
 * 列表带短时缓存，写标签串行执行，避免并发写坏 NapCat 侧的描述。
 */
export class FavoriteStore {
  private readonly writeMutex = new Mutex()
  private cache: { faces: CustomFace[]; expires: number } | undefined
  private inflight: Promise<CustomFace[]> | undefined

  constructor(
    private readonly call: OneBotCall,
    private readonly logger: Logger,
    private readonly ttlMs = FAVORITE_CACHE_TTL_MS,
  ) {}

  /** 读取收藏表情列表；短时间内的重复请求走缓存。 */
  async list(options: { refresh?: boolean } = {}): Promise<CustomFace[]> {
    if (!options.refresh) {
      const cached = this.cache
      if (cached && cached.expires > Date.now()) return cached.faces
    }
    // 刷新时先等在途请求结束，再重新拉取，避免刷新被在途请求吞掉。
    const inflight = this.inflight
    if (inflight) await inflight.catch(() => {})
    this.inflight ??= this.fetch().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  private async fetch(): Promise<CustomFace[]> {
    try {
      const data = await this.call("fetch_custom_face_detail", { count: FAVORITE_FETCH_COUNT })
      const items = Array.isArray(data) ? data : []
      const faces = items.filter(
        (item): item is CustomFace => typeof item === "object" && item !== null,
      )
      this.cache = { faces, expires: Date.now() + this.ttlMs }
      return faces
    } catch (error) {
      this.logger.error("读取收藏表情失败", error)
      return this.cache?.faces ?? []
    }
  }

  /**
   * 写入标签。
   *
   * 标签只写在 NapCat 的 `desc` 字段里，插件不保存副本。
   */
  async setTag(face: CustomFace, tag: string): Promise<boolean> {
    const { emoId, resId, md5 } = face
    if (emoId === undefined || !resId || !md5) {
      this.logger.warn("收藏表情缺少 emoId/res_id/md5，无法写入标签")
      return false
    }
    return this.writeMutex.runExclusive(async () => {
      try {
        await this.call("set_custom_face_desc", {
          emoji_id: emoId,
          res_id: resId,
          md5,
          desc: tag,
        })
        this.invalidate()
        return true
      } catch (error) {
        this.logger.error(`写入收藏表情标签失败 res_id=${resId}`, error)
        return false
      }
    })
  }

  /** 让缓存失效，下次读取重新拉取。 */
  invalidate(): void {
    this.cache = undefined
  }
}
