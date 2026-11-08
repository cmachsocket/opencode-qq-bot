import { createHash } from "node:crypto"
import { access, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Logger } from "../logger"
import { defaultMediaDir } from "../media-path"
import { type SafeFetcher, safeFetchBytes } from "../safe-fetch"

/** 单张图片下载与落盘的字节上限。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** 下载远端图片的超时时间。 */
export const IMAGE_FETCH_TIMEOUT_MS = 15_000
/** 临时图片的保留时间。 */
export const MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface PromptFile {
  uri: string
  name: string
  /** 原始字节数，用于图片预算与缓存上限。 */
  bytes?: number
  /** 文件来源；file: 引用会标记为 uri。 */
  source?: { type: "inline" } | { type: "uri"; uri: string }
}

export interface StoredImage extends PromptFile {
  /** 图片扩展名，不含点。 */
  ext: string
}

interface ImageBytes {
  bytes: Uint8Array
  mime: string
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

/** 从魔数判断图片类型。 */
export function mimeFromBytes(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png"
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg"
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif"
  }
  if (
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp"
  }
  return undefined
}

/** 估算 data URL 里原始图片的字节数。 */
export function inlineImageBytes(uri: string): number {
  const comma = uri.indexOf(",")
  if (comma < 0) return 0
  return Math.floor(((uri.length - comma - 1) * 3) / 4)
}

/** 按 Unicode 码点截断，避免切断代理对。 */
function truncateCodePoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("")
}

/** 截断过长的地址，避免日志被超长 URL 淹没。 */
function truncateForLog(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return undefined
  const bytes = Buffer.from(value, "base64")
  return bytes.byteLength > MAX_IMAGE_BYTES ? undefined : new Uint8Array(bytes)
}

function parseDataUrl(uri: string, logger: Logger): ImageBytes | undefined {
  const match = /^data:([^;,]+)?(?:;[^,]*)*;base64,(.*)$/s.exec(uri)
  if (!match) return undefined
  const bytes = decodeBase64(match[2] ?? "")
  if (!bytes) return undefined
  // 以魔数嗅探为准：URI 里声明的类型由消息发送方控制，不能直接信任。
  const mime = mimeFromBytes(bytes)
  if (!mime) {
    logger.warn("data URL 图片类型无法识别")
    return undefined
  }
  const declared = match[1]?.trim()
  if (declared && declared !== mime) {
    logger.warn(`data URL 声明类型与实际内容不符 declared=${declared} actual=${mime}`)
  }
  return { bytes, mime }
}

/**
 * 受控的图片文件存储。
 *
 * 图片下载后写入临时目录，prompt 里只传 `file:` 引用，
 * 避免 base64 字符串进入插件缓存与会话参数。
 */
export class MediaStore {
  private ready: Promise<void> | undefined

  constructor(
    private readonly root: string,
    private readonly logger: Logger,
    private readonly ttlMs = MEDIA_TTL_MS,
    private readonly fetcher: SafeFetcher = safeFetchBytes,
  ) {}

  private async ensureRoot(): Promise<void> {
    this.ready ??= mkdir(this.root, { recursive: true, mode: 0o700 }).then(() => undefined)
    await this.ready
  }

  /** 下载或解码图片并写入临时文件；失败时返回 undefined。 */
  async storeImage(url: string): Promise<StoredImage | undefined> {
    const image = await this.readImage(url)
    if (!image) return undefined
    return this.storeBytes(image.bytes, image.mime)
  }

  private async readImage(url: string): Promise<ImageBytes | undefined> {
    if (url.startsWith("base64://")) {
      const bytes = decodeBase64(url.slice("base64://".length))
      if (!bytes) {
        this.logger.warn("base64 图片无效或超过大小上限")
        return undefined
      }
      const mime = mimeFromBytes(bytes)
      if (!mime) {
        this.logger.warn("base64 图片类型无法识别")
        return undefined
      }
      return { bytes, mime }
    }
    if (url.startsWith("data:")) return parseDataUrl(url, this.logger)
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      this.logger.warn(`不支持的图片地址，跳过下载 url=${truncateForLog(url)}`)
      return undefined
    }

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return undefined
    }
    const response = await this.fetcher(parsed, {
      maxBytes: MAX_IMAGE_BYTES,
      timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
      logger: this.logger,
    })
    if (!response) return undefined
    if (response.bytes.byteLength > MAX_IMAGE_BYTES) {
      this.logger.warn(`图片过大，跳过下载 bytes=${response.bytes.byteLength} url=${url}`)
      return undefined
    }

    // 声明类型只能当参考：服务器可能把 HTML 标成 image/png，或返回不支持的 svg。
    const declared = response.contentType?.split(";")[0]?.trim()
    const mime = mimeFromBytes(response.bytes)
    if (!mime) {
      this.logger.warn(`图片类型无法识别 url=${url} declared=${declared ?? "无"}`)
      return undefined
    }
    if (declared?.startsWith("image/") === true && declared !== mime) {
      this.logger.warn(`图片类型与声明不一致 declared=${declared} actual=${mime} url=${url}`)
    }
    return { bytes: response.bytes, mime }
  }

  private async storeBytes(bytes: Uint8Array, mime: string): Promise<StoredImage> {
    await this.ensureRoot()
    const hash = createHash("sha256").update(bytes).digest("hex")
    const ext = MIME_EXTENSIONS[mime] ?? "bin"
    const path = join(this.root, `${hash}.${ext}`)
    try {
      await access(path)
    } catch {
      await writeFile(path, bytes, { mode: 0o600 })
    }
    const uri = pathToFileURL(path).href
    return {
      uri,
      name: `qq-image-${hash.slice(0, 8)}.${ext}`,
      bytes: bytes.byteLength,
      source: { type: "uri", uri },
      ext,
    }
  }

  /** 删除超过 TTL 的临时图片。 */
  async cleanup(now = Date.now()): Promise<number> {
    let removed = 0
    try {
      const entries = await readdir(this.root)
      for (const entry of entries) {
        const path = join(this.root, entry)
        try {
          const info = await stat(path)
          if (!info.isFile() || now - info.mtimeMs <= this.ttlMs) continue
          await unlink(path)
          removed += 1
        } catch {
          // 文件可能已被其它实例删除。
        }
      }
    } catch {
      // 目录不存在时无需清理。
    }
    if (removed > 0) this.logger.debug(`已清理 ${removed} 个过期图片文件`)
    return removed
  }
}

/** 创建默认的临时图片存储，并立即清理一次过期文件。 */
export async function createMediaStore(
  logger: Logger,
  options: { root?: string; ttlMs?: number; fetcher?: SafeFetcher } = {},
): Promise<MediaStore> {
  const root = options.root ?? defaultMediaDir()
  const store = new MediaStore(root, logger, options.ttlMs, options.fetcher)
  await store.cleanup()
  return store
}

/** 供需要按码点截断的渲染代码复用。 */
export { truncateCodePoints }
