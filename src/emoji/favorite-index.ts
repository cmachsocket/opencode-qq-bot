import type { Plugin } from "@opencode/plugin"
import { Mutex } from "async-mutex"
import type { Logger } from "../logger"
import { type CustomFace, faceTag, type FavoriteRow } from "./favorites"

/** 插件存储里收藏表情编号索引的键。 */
export const FAVORITE_INDEX_KEY = "emoji-favorite-index"

/** 编号索引用到的插件存储接口。 */
export type IndexStorage = Pick<Plugin.Context["storage"], "get" | "set">

/**
 * 收藏表情的身份键。
 *
 * 绝对依据是图片的 `md5`：同一张图就是同一个收藏表情，NapCat 侧的
 * `emo_id`、`res_id`、列表顺序变化都不影响认回。
 *
 * `md5` 缺失时退到 `res_id`，再退到 `emo_id`。
 */
export function favoriteKey(face: CustomFace): string | undefined {
  const md5 = typeof face.md5 === "string" ? face.md5.trim().toLowerCase() : ""
  if (md5.length > 0) return `md5:${md5}`
  const resId = typeof face.resId === "string" ? face.resId.trim() : ""
  if (resId.length > 0) return `res:${resId}`
  if (face.emoId !== undefined && face.emoId !== null) return `emo:${String(face.emoId)}`
  return undefined
}

interface StoredEntry {
  key: string
  id: number
}

/** 从插件存储里读回编号记录，格式不对就当没有。 */
function parseEntries(stored: unknown): StoredEntry[] {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return []
  const raw = (stored as { entries?: unknown }).entries
  if (!Array.isArray(raw)) return []
  const entries: StoredEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const { key, id } = item as { key?: unknown; id?: unknown }
    if (typeof key !== "string" || key.length === 0) continue
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) continue
    entries.push({ key, id })
  }
  return entries
}

/**
 * 插件自维护的收藏表情编号。
 *
 * 编号只是发图片时的句柄，真正的身份依据是图片 `md5`；编号按首次出现的顺序
 * 从 1 开始分配，写在插件存储里，之后每次读取都按身份键认回原来的编号，
 * 所以 NapCat 侧的 `emo_id` 变化、列表顺序变化都不影响编号，
 * 被删掉的收藏表情留下的编号也不会再分配给别的表情。
 */
export class FavoriteIndex {
  private readonly entries = new Map<string, number>()
  private readonly mutex = new Mutex()
  private loading: Promise<void> | undefined
  private loaded = false

  constructor(
    private readonly storage: IndexStorage,
    private readonly logger: Logger,
  ) {}

  /**
   * 读取收藏表情列表并给每个表情配上编号。
   *
   * 返回的顺序按编号从小到大；`md5` 相同的记录视为同一个表情，只保留一条。
   */
  async sync(faces: readonly CustomFace[]): Promise<FavoriteRow[]> {
    await this.ensureLoaded()
    const rows: FavoriteRow[] = []
    const seen = new Set<string>()
    let changed = false
    let nextId = this.nextId()
    for (const face of faces) {
      const key = favoriteKey(face)
      if (!key) continue
      if (seen.has(key)) {
        this.logger.warn("收藏表情存在相同 md5 的重复记录，按 md5 去重")
        continue
      }
      seen.add(key)
      let id = this.entries.get(key)
      if (id === undefined) {
        id = nextId
        nextId += 1
        this.entries.set(key, id)
        changed = true
      }
      rows.push({ id, face, tag: faceTag(face) })
    }
    rows.sort((left, right) => left.id - right.id)
    if (changed) await this.persist()
    return rows
  }

  /** 按编号找收藏表情；编号不存在时返回 undefined。 */
  async resolve(faces: readonly CustomFace[], id: number): Promise<FavoriteRow | undefined> {
    const rows = await this.sync(faces)
    return rows.find((row) => row.id === id)
  }

  /** 下一个可用的编号。 */
  private nextId(): number {
    let max = 0
    for (const id of this.entries.values()) {
      if (id > max) max = id
    }
    return max + 1
  }

  /** 从插件存储恢复编号索引；读取失败下次重试，不影响正常使用。 */
  private ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    this.loading ??= this.read()
      .then(() => {
        this.loaded = true
      })
      .catch((error: unknown) => {
        // 读取失败不缓存结果，下次调用重新读，避免索引长期为空、编号从头分配。
        this.logger.warn("读取收藏表情编号索引失败", error)
        this.loading = undefined
      })
    return this.loading
  }

  private async read(): Promise<void> {
    const stored = await this.storage.get(FAVORITE_INDEX_KEY)
    for (const entry of parseEntries(stored)) {
      if (!this.entries.has(entry.key)) this.entries.set(entry.key, entry.id)
    }
  }

  /** 写回编号索引，串行执行避免互相覆盖。 */
  private async persist(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      try {
        const entries = [...this.entries.entries()].map(([key, id]) => ({ key, id }))
        await this.storage.set(FAVORITE_INDEX_KEY, { version: 1, entries })
      } catch (error) {
        this.logger.error("保存收藏表情编号索引失败", error)
      }
    })
  }
}
