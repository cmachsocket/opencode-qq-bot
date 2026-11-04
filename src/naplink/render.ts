import type { GroupMessageEvent, MessageSegment, OneBotApi } from "@naplink/naplink"
import type { Logger } from "../logger"

/** 合并转发的解析上限，避免撑爆上下文。 */
export const MAX_FORWARD_DEPTH = 3
export const MAX_FORWARD_NODES = 50
export const MAX_FORWARD_CHARS = 4000
/** 单张图片内联进 prompt 的字节上限，超过则降级为占位文本。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** 单轮提示里最多内联的图片数量，超出的图片只保留占位文本。 */
export const MAX_PROMPT_IMAGES = 8
/** 单轮提示里内联图片的原始字节总量上限，超出的图片只保留占位文本。 */
export const MAX_PROMPT_IMAGE_BYTES = 16 * 1024 * 1024

export interface PromptFile {
  uri: string
  name: string
}

export interface RenderedMessage {
  /** 纯文本版本，用于会话历史与提示词。 */
  text: string
  /** 图片附件，交给 OpenCode 作为多模态输入。 */
  files: PromptFile[]
}

export interface RenderContext {
  api: OneBotApi
  groupId: number
  logger: Logger
}

/** NapCat 的 forward 段不在 SDK 类型里，这里补进判别联合。 */
interface ForwardSegment {
  type: "forward"
  data: { id?: string }
}

type Segment = MessageSegment | ForwardSegment

function segments(message: readonly MessageSegment[]): readonly Segment[] {
  return message as readonly Segment[]
}

/** 判断消息是否含有值得交给模型的内容。 */
export function shouldProcess(message: readonly MessageSegment[]): boolean {
  return segments(message).some((segment) => {
    switch (segment.type) {
      case "text":
        return segment.data.text.trim().length > 0
      case "image":
      case "record":
      case "forward":
        return true
      default:
        return false
    }
  })
}

/** 判断消息里是否 @ 了指定 QQ 号。 */
export function mentionsUser(
  message: readonly MessageSegment[],
  userId: string | undefined,
): boolean {
  if (!userId) return false
  return segments(message).some(
    (segment) => segment.type === "at" && String(segment.data.qq) === userId,
  )
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

/** 从 data URL 的 MIME 推断文件扩展名。 */
function extensionFor(dataUrl: string): string {
  if (!dataUrl.startsWith("data:")) return "png"
  const mime = dataUrl.slice("data:".length, dataUrl.indexOf(";"))
  return MIME_EXTENSIONS[mime] ?? "png"
}

/**
 * 通过魔数判断图片类型。
 *
 * NapCat 经常把图片的 content-type 写成 application/octet-stream，
 * 这时只能用魔数兜底，否则扩展名与 MIME 都会错。
 */
function mimeFromBytes(bytes: Uint8Array): string | undefined {
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

/** 内联图片的预算：数量与字节总量，渲染过程中边用边扣。 */
export interface ImageBudget {
  images: number
  bytes: number
}

/** 创建一份默认图片预算。 */
export function createImageBudget(): ImageBudget {
  return { images: MAX_PROMPT_IMAGES, bytes: MAX_PROMPT_IMAGE_BYTES }
}

/** 估算 data URL 里原始图片的字节数。 */
export function inlineImageBytes(uri: string): number {
  const comma = uri.indexOf(",")
  if (comma < 0) return 0
  return Math.floor(((uri.length - comma - 1) * 3) / 4)
}

/** 从预算里扣掉一张图片；预算不足时不扣。 */
function takeImage(budget: ImageBudget, uri: string): boolean {
  const bytes = inlineImageBytes(uri)
  if (budget.images <= 0 || budget.bytes < bytes) return false
  budget.images -= 1
  budget.bytes -= bytes
  return true
}

/** 按预算裁剪图片附件列表（数量与字节总量）。 */
export function limitFiles(files: readonly PromptFile[]): PromptFile[] {
  const budget = createImageBudget()
  const kept: PromptFile[] = []
  for (const file of files) {
    if (!takeImage(budget, file.uri)) continue
    kept.push(file)
  }
  return kept
}

/**
 * 读取响应体，超过上限就中断。
 *
 * 先按 content-length 判断，读的时候再限长，避免超大图片先撑爆内存。
 */
async function readCapped(response: Response, limit: number): Promise<Uint8Array | undefined> {
  const body = response.body
  if (!body) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    return buffer.byteLength > limit ? undefined : buffer
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        return undefined
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const buffer = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }
  return buffer
}

/**
 * 把图片地址转成可内联的 data URL。
 *
 * OpenCode 的附件不支持 http(s) 地址，只接受 ``file:`` 与 ``data:``，
 * 因此远端图片必须先下载再内联。
 */
export async function toInlineImage(url: string, logger: Logger): Promise<string | undefined> {
  if (url.startsWith("base64://")) return `data:image/png;base64,${url.slice("base64://".length)}`
  if (url.startsWith("data:")) return url
  if (!url.startsWith("http://") && !url.startsWith("https://")) return undefined
  try {
    const response = await fetch(url)
    if (!response.ok) {
      logger.warn(`下载图片失败 status=${response.status} url=${url}`)
      return undefined
    }
    const lengthHeader = response.headers.get("content-length")
    const declaredLength = lengthHeader === null ? undefined : Number(lengthHeader)
    if (declaredLength !== undefined && Number.isFinite(declaredLength)) {
      if (declaredLength > MAX_IMAGE_BYTES) {
        logger.warn(`图片过大，跳过内联 bytes=${declaredLength} url=${url}`)
        return undefined
      }
    }
    const buffer = await readCapped(response, MAX_IMAGE_BYTES)
    if (!buffer) {
      logger.warn(`图片过大，跳过内联 url=${url}`)
      return undefined
    }
    const declared = response.headers.get("content-type")?.split(";")[0]?.trim()
    const mime = declared?.startsWith("image/") ? declared : (mimeFromBytes(buffer) ?? "image/png")
    return `data:${mime};base64,${Buffer.from(buffer).toString("base64")}`
  } catch (error) {
    logger.warn(`下载图片异常 url=${url}`, error)
    return undefined
  }
}

/** 查询用户在群里的显示名：优先群名片，再退回 QQ 昵称。 */
export async function resolveUserName(ctx: RenderContext, userId: string): Promise<string> {
  if (userId === "all") return "全体成员"
  try {
    const info = (await ctx.api.getGroupMemberInfo(ctx.groupId, userId)) as
      { card?: string; nickname?: string } | undefined
    if (!info) return "未知用户"
    return info.card?.trim() || info.nickname?.trim() || "未知用户"
  } catch (error) {
    ctx.logger.warn(`获取群成员信息失败 user_id=${userId}`, error)
    return "未知用户"
  }
}

interface ForwardContent {
  text: string
  images: string[]
}

async function renderForwardSegments(
  ctx: RenderContext,
  message: readonly MessageSegment[],
  depth: number,
  budget: ImageBudget,
): Promise<ForwardContent> {
  const parts: string[] = []
  const images: string[] = []
  for (const segment of segments(message)) {
    switch (segment.type) {
      case "text":
        parts.push(segment.data.text)
        break
      case "at":
        parts.push(`@${segment.data.qq} `)
        break
      case "image": {
        parts.push("[图片]")
        const url = segment.data.url || segment.data.file
        if (!url || budget.images <= 0) break
        const inline = await toInlineImage(url, ctx.logger)
        if (!inline || !takeImage(budget, inline)) break
        images.push(inline)
        break
      }
      case "record":
        parts.push("[语音]")
        break
      case "video":
        parts.push("[视频]")
        break
      case "audio":
        parts.push("[音频]")
        break
      case "file":
        parts.push(`[文件]${segment.data.name || segment.data.file}`)
        break
      case "face":
        parts.push("[表情]")
        break
      case "json":
        parts.push("[卡片消息]")
        break
      case "xml":
        parts.push("[XML消息]")
        break
      case "markdown":
        parts.push("[Markdown消息]")
        break
      case "reply":
        // 转发节点里的引用没有上下文，跳过
        break
      case "forward": {
        if (depth >= MAX_FORWARD_DEPTH) {
          parts.push("[嵌套合并转发]")
          break
        }
        const nested = await renderForward(ctx, segment.data.id, depth + 1, budget)
        parts.push(nested.text)
        images.push(...nested.images)
        break
      }
      default:
        break
    }
  }
  return { text: parts.join("").trim(), images }
}

/** 把合并转发解析成 ``<forward>`` 文本块，并附带其中的图片。 */
export async function renderForward(
  ctx: RenderContext,
  id: string | undefined,
  depth = 0,
  budget: ImageBudget = createImageBudget(),
): Promise<ForwardContent> {
  if (!id) return { text: "[合并转发]", images: [] }
  let nodes: { name: string; segments: MessageSegment[] }[] = []
  try {
    const data = (await ctx.api.getForwardMessage(id)) as {
      messages?: {
        sender?: { user_id?: number; nickname?: string; card?: string }
        message?: unknown[]
      }[]
    }
    nodes = (data.messages ?? [])
      .filter((entry) => entry.sender)
      .map((entry) => ({
        name:
          entry.sender?.card ||
          entry.sender?.nickname ||
          String(entry.sender?.user_id ?? "未知用户"),
        segments: (entry.message ?? []) as MessageSegment[],
      }))
  } catch (error) {
    ctx.logger.warn(`解析合并转发失败 id=${id}`, error)
    return { text: "[合并转发（获取失败）]", images: [] }
  }
  if (nodes.length === 0) return { text: "[合并转发]", images: [] }

  const lines = ["<forward>"]
  const images: string[] = []
  for (const node of nodes.slice(0, MAX_FORWARD_NODES)) {
    const body = await renderForwardSegments(ctx, node.segments, depth, budget)
    lines.push(`${node.name}：${body.text || "[空消息]"}`)
    images.push(...body.images)
  }
  if (nodes.length > MAX_FORWARD_NODES) {
    lines.push(`...（还有 ${nodes.length - MAX_FORWARD_NODES} 条）`)
  }
  lines.push("</forward>")

  let rendered = lines.join("\n")
  if (rendered.length > MAX_FORWARD_CHARS) {
    rendered = `${rendered.slice(0, MAX_FORWARD_CHARS)}\n...（合并转发过长，已截断）`
  }
  return { text: rendered, images }
}

/** 把语音消息转成文字，转写失败时返回空字符串。 */
export async function fetchVoiceText(
  ctx: RenderContext,
  messageId: number | undefined,
): Promise<string> {
  if (messageId === undefined) return ""
  try {
    const result = await ctx.api.fetchPttText(messageId)
    return result?.text?.trim() ?? ""
  } catch (error) {
    ctx.logger.warn(`语音转文字失败 message_id=${messageId}`, error)
    return ""
  }
}

/**
 * 把一条群消息拆成 (纯文本, 图片附件)。
 *
 * 引用消息会展开成 ``<quote>`` 块，合并转发展开成 ``<forward>`` 块，
 * 图片既留占位文本又内联成附件，语音先转写成文字。
 */
export async function renderMessage(
  ctx: RenderContext,
  event: GroupMessageEvent,
): Promise<RenderedMessage> {
  const textBuffer: string[] = []
  const files: PromptFile[] = []
  const message = segments(event.message)

  const replySegments = message.filter((segment) => segment.type === "reply")
  if (replySegments.length > 0) {
    const quoteLines = ["<quote>"]
    for (const segment of replySegments) {
      if (!segment.data.id) continue
      try {
        const data = (await ctx.api.getMessage(segment.data.id)) as
          { sender?: { user_id?: number }; message?: MessageSegment[] } | undefined
        if (!data) continue
        const name = data.sender?.user_id
          ? await resolveUserName(ctx, String(data.sender.user_id))
          : "未知用户"
        const quoted = (data.message ?? [])
          .filter((entry) => entry.type === "text")
          .map((entry) => entry.data.text)
          .join("")
        quoteLines.push(`${name}：${quoted}`)
      } catch (error) {
        ctx.logger.warn(`获取引用消息失败 id=${segment.data.id}`, error)
      }
    }
    quoteLines.push("</quote>")
    textBuffer.push(`${quoteLines.join("\n")}\n`)
  }

  const hasRecord = message.some((segment) => segment.type === "record")
  const voiceText = hasRecord ? await fetchVoiceText(ctx, event.message_id) : ""

  const budget = createImageBudget()
  let imageIndex = 0
  for (const segment of message) {
    switch (segment.type) {
      case "text":
        textBuffer.push(segment.data.text)
        break
      case "at":
        textBuffer.push(`@${await resolveUserName(ctx, String(segment.data.qq))} `)
        break
      case "image": {
        textBuffer.push("[图片] ")
        const url = segment.data.url || segment.data.file
        if (!url || budget.images <= 0) break
        const inline = await toInlineImage(url, ctx.logger)
        if (!inline || !takeImage(budget, inline)) break
        imageIndex += 1
        files.push({ uri: inline, name: `qq-image-${imageIndex}.${extensionFor(inline)}` })
        break
      }
      case "record": {
        textBuffer.push(voiceText ? `[语音] ${voiceText}` : "[语音]")
        break
      }
      case "reply":
        // 已在外层 quote 块处理过
        break
      case "forward": {
        const forward = await renderForward(ctx, segment.data.id, 0, budget)
        const prefix =
          textBuffer.length > 0 && !textBuffer[textBuffer.length - 1]?.endsWith("\n") ? "\n" : ""
        textBuffer.push(`${prefix}${forward.text}\n`)
        for (const image of forward.images) {
          imageIndex += 1
          files.push({
            uri: image,
            name: `qq-forward-${imageIndex}.${extensionFor(image)}`,
          })
        }
        break
      }
      case "video":
        textBuffer.push("[视频]")
        break
      case "audio":
        textBuffer.push("[音频]")
        break
      case "file":
        textBuffer.push(`[文件]${segment.data.name || segment.data.file}`)
        break
      case "face":
        textBuffer.push("[表情]")
        break
      case "json":
        textBuffer.push("[卡片消息]")
        break
      case "xml":
        textBuffer.push("[XML消息]")
        break
      case "markdown":
        textBuffer.push("[Markdown消息]")
        break
      default:
        ctx.logger.debug(`跳过未知消息段 type=${(segment as { type: string }).type}`)
        break
    }
  }

  return { text: textBuffer.join(""), files }
}
