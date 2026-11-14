import { createHash } from "node:crypto"
import { chmod, copyFile, mkdir, open, readFile, unlink } from "node:fs/promises"
import { extname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import { Mutex } from "async-mutex"
import { type ChatTarget, targetKey } from "../chat"
import type { Logger } from "../logger"
import type { PromptFile } from "../naplink/media"

/** 收藏描述最长字数。 */
export const MAX_DESCRIPTION_LENGTH = 12

/** 收藏描述的规则说明；描述不合规时原样回给模型。 */
export const DESCRIPTION_RULES = `描述要是一个中文名字，最多 ${MAX_DESCRIPTION_LENGTH} 个字，只能用文字和数字，不要标点、空格、引号、解释。`

/** 描述校验结果。 */
export type DescriptionCheck = { ok: true; value: string } | { ok: false; reason: string }

/**
 * 校验收藏描述。
 *
 * 描述会写进收藏列表，模型必须一次给出合规的名字：
 * 只有文字和数字、不带空格标点、不超过 12 个字。
 */
export function checkDescription(raw: unknown): DescriptionCheck {
  if (typeof raw !== "string") return { ok: false, reason: "缺少 description（收藏描述）" }
  const value = raw.trim()
  if (!value) return { ok: false, reason: "缺少 description（收藏描述）" }
  if (/\s/u.test(value)) return { ok: false, reason: "描述里不能有空格" }
  const chars = Array.from(value)
  if (chars.some((char) => !/[\p{L}\p{N}]/u.test(char))) {
    return { ok: false, reason: "描述里只能有文字和数字" }
  }
  if (chars.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, reason: `描述最多 ${MAX_DESCRIPTION_LENGTH} 个字` }
  }
  return { ok: true, value }
}

/** 插件存储里收藏清单的键。 */
export const COLLECTION_KEY = "emoji-collection"
/** 收藏文件在媒体目录下的子目录名。 */
export const COLLECTION_DIR = "favorites"
/** 本机收藏的表情数量上限，超出后丢掉最早收藏的。 */
export const MAX_COLLECTED_STICKERS = 200

/** 本机收集的表情。 */
export type CollectedSticker = {
  /** 图片 md5，作为身份键。 */
  md5: string
  /** 收藏描述。 */
  description: string
  /** 本地文件绝对路径。 */
  file: string
  /** 收藏时间（毫秒）。 */
  createdAt: number
}

/** 收藏存储用到的插件存储接口。 */
export type CollectionStorage = Pick<Plugin.Context["storage"], "get" | "set">

/**
 * 本机收集的表情清单。
 *
 * QQ 客户端的收藏表情只有 NapCat 能写，插件收集的动图只能自己存：
 * 图片复制到媒体目录下的收藏子目录，元数据写在插件存储里。
 */
export class CollectionStore {
  private readonly mutex = new Mutex()
  private items: CollectedSticker[] = []
  private loaded = false
  private loading: Promise<void> | undefined

  constructor(
    private readonly storage: CollectionStorage,
    /** 媒体目录：收藏文件放在它的收藏子目录里。 */
    private readonly root: string,
    private readonly logger: Logger,
  ) {}

  /** 收藏清单，按收藏先后返回。 */
  async list(): Promise<CollectedSticker[]> {
    await this.ensureLoaded()
    return [...this.items]
  }

  /**
   * 收藏一张图片。
   *
   * 图片复制到收藏目录，元数据写进插件存储；
   * 同一张图重复收藏只更新描述，文件不重复存。
   */
  async add(source: string, description: string): Promise<CollectedSticker> {
    return this.mutex.runExclusive(async () => {
      await this.ensureLoaded()
      const bytes = await readFile(source)
      const md5 = createHash("md5").update(bytes).digest("hex")
      const ext = extname(source).replace(/^\./, "").toLowerCase() || "bin"
      const dir = join(this.root, COLLECTION_DIR)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const file = join(dir, `${md5}.${ext}`)
      await copyFile(source, file)
      await chmod(file, 0o600)
      const existing = this.items.find((item) => item.md5 === md5)
      const sticker: CollectedSticker = {
        md5,
        description,
        file,
        createdAt: existing?.createdAt ?? Date.now(),
      }
      this.items = existing
        ? this.items.map((item) => (item.md5 === md5 ? sticker : item))
        : [...this.items, sticker]
      await this.enforceLimit()
      await this.persist()
      return sticker
    })
  }

  /** 超过上限时丢掉最早收藏的，连同它的文件一起删掉。 */
  private async enforceLimit(): Promise<void> {
    while (this.items.length > MAX_COLLECTED_STICKERS) {
      const oldest = this.items.shift()
      if (!oldest) break
      // 只删收藏目录里的文件：存储被污染过时不能让它去删别处的文件。
      if (!this.insideCollection(oldest.file)) continue
      try {
        await unlink(oldest.file)
      } catch {
        // 文件可能已经被删掉，不影响清单。
      }
    }
  }

  /** 这个路径是不是收藏目录里的文件。 */
  private insideCollection(file: string): boolean {
    const dir = resolve(this.root, COLLECTION_DIR)
    const target = resolve(file)
    return target.startsWith(`${dir}${sep}`)
  }

  /** 从插件存储恢复清单；读取失败下次重试。 */
  private ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    this.loading ??= this.read()
      .then(() => {
        this.loaded = true
      })
      .catch((error: unknown) => {
        this.logger.warn("读取收藏清单失败", error)
        this.loading = undefined
      })
    return this.loading
  }

  private async read(): Promise<void> {
    const stored = await this.storage.get(COLLECTION_KEY)
    const raw = (stored as { items?: unknown } | undefined)?.items
    if (!Array.isArray(raw)) return
    const items: CollectedSticker[] = []
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue
      const { md5, description, file, createdAt } = entry as Record<string, unknown>
      if (typeof md5 !== "string" || md5.length === 0) continue
      if (typeof description !== "string" || description.length === 0) continue
      if (typeof file !== "string" || file.length === 0) continue
      // 存储里的路径必须落在收藏目录里：清单被污染时不至于指到别处。
      if (!this.insideCollection(file)) {
        this.logger.warn(`收藏清单里的文件路径不在收藏目录内，已忽略：${file}`)
        continue
      }
      items.push({
        md5,
        description,
        file,
        createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0,
      })
    }
    this.items = items
  }

  /** 写回清单；失败只记日志。 */
  private async persist(): Promise<void> {
    try {
      await this.storage.set(COLLECTION_KEY, { version: 1, items: this.items })
    } catch (error) {
      this.logger.error("保存收藏清单失败", error)
    }
  }
}

/** 最近收到的图片在内存里保留的时间。 */
export const RECENT_IMAGE_TTL_MS = 30 * 60 * 1000
/** 每个聊天最多保留多少张最近收到的图片。 */
export const MAX_RECENT_IMAGES = 12
/** 同时记着多少个聊天：聊天数不封顶时这张表会一直涨。 */
export const MAX_TRACKED_CHATS = 64

/** 收到的一张图片。 */
export interface ReceivedImage {
  /** 本地文件绝对路径。 */
  file: string
  /** 扩展名，不含点。 */
  ext: string
  /** 是否动图。 */
  animated: boolean
  /** 收到时间（毫秒）。 */
  at: number
  /** 来源消息 ID。 */
  messageId?: string
}

/** 把附件引用还原成本地路径；不是本地文件时返回 undefined。 */
function localPath(uri: string): string | undefined {
  if (uri.startsWith("file:")) {
    try {
      return fileURLToPath(uri)
    } catch {
      return undefined
    }
  }
  return uri.startsWith("/") ? uri : undefined
}

/**
 * 判断图片是不是动图。
 *
 * GIF 一律当动图；WebP 要看有没有 `ANIM` 块。
 */
async function isAnimatedImage(file: string, ext: string): Promise<boolean> {
  if (ext === "gif") return true
  if (ext !== "webp") return false
  try {
    const handle = await open(file, "r")
    try {
      const buffer = Buffer.alloc(256)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return buffer.subarray(0, bytesRead).includes("ANIM")
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

/**
 * 各聊天最近收到的图片。
 *
 * 收藏表情要有个来源：这个表记住每个聊天刚收到过哪些图片，
 * 收藏时从中挑最近收到的那张动图。
 */
export class RecentImages {
  private readonly chats = new Map<string, ReceivedImage[]>()

  constructor(private readonly ttlMs = RECENT_IMAGE_TTL_MS) {}

  /** 记下一条消息里的图片。 */
  async record(
    target: ChatTarget,
    files: readonly PromptFile[],
    messageId?: string,
  ): Promise<void> {
    const images: ReceivedImage[] = []
    for (const file of files) {
      const path = localPath(file.uri)
      if (!path) continue
      const ext = extname(path).replace(/^\./, "").toLowerCase()
      if (!ext) continue
      images.push({
        file: path,
        ext,
        animated: await isAnimatedImage(path, ext),
        at: Date.now(),
        ...(messageId ? { messageId } : {}),
      })
    }
    if (images.length === 0) return
    const key = targetKey(target)
    if (!this.chats.has(key)) this.evictChat()
    const items = [...(this.chats.get(key) ?? []), ...images]
    while (items.length > MAX_RECENT_IMAGES) items.shift()
    this.chats.set(key, items)
  }

  /** 聊天太多时丢掉最久没更新的那个。 */
  private evictChat(): void {
    if (this.chats.size < MAX_TRACKED_CHATS) return
    let oldestKey: string | undefined
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [key, items] of this.chats) {
      const at = items[items.length - 1]?.at ?? 0
      if (at < oldestAt) {
        oldestAt = at
        oldestKey = key
      }
    }
    if (oldestKey !== undefined) this.chats.delete(oldestKey)
  }

  /** 这个聊天最近收到的图片，只返回还在保留期内的。 */
  list(target: ChatTarget): ReceivedImage[] {
    const key = targetKey(target)
    const now = Date.now()
    const items = (this.chats.get(key) ?? []).filter((item) => now - item.at < this.ttlMs)
    if (items.length > 0) this.chats.set(key, items)
    return [...items]
  }

  /**
   * 最近收到的一张图片。
   *
   * 要求动图时只在动图里找最新的那张。
   */
  latest(target: ChatTarget, options: { animated?: boolean } = {}): ReceivedImage | undefined {
    const items = this.list(target)
    const candidates = options.animated ? items.filter((item) => item.animated) : items
    return candidates[candidates.length - 1]
  }
}
