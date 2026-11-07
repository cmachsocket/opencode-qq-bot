import type { MessageEvent, MessageSegment, OneBotApi } from "@naplink/naplink"
import type { ChatTarget } from "../chat"
import { targetKey } from "../chat"
import { isCustomFaceImage } from "../emoji/favorites"
import { renderFace } from "../emoji/faces"
import type { Logger } from "../logger"
import { sanitizeSenderName, sanitizeUntrustedText } from "../model-view"
import { hydrateSegment } from "./client"
import {
  MAX_IMAGE_BYTES,
  inlineImageBytes,
  truncateCodePoints,
  type MediaStore,
  type PromptFile,
  type StoredImage,
} from "./media"

export { MAX_IMAGE_BYTES, inlineImageBytes }
export type { PromptFile } from "./media"

/** 合并转发的解析上限，避免撑爆上下文。 */
export const MAX_FORWARD_DEPTH = 3
export const MAX_FORWARD_NODES = 50
export const MAX_FORWARD_CHARS = 4000
/** 整棵转发树最多解析的节点数，避免嵌套转发把 API 调用放大。 */
export const MAX_FORWARD_TOTAL_NODES = 100
/** 整棵转发树最多保留的字符数。 */
export const MAX_FORWARD_TOTAL_CHARS = 8000
/** 单轮提示里最多引用的图片数量，超出的图片只保留占位文本。 */
export const MAX_PROMPT_IMAGES = 8
/** 单轮提示里引用图片的原始字节总量上限，超出的图片只保留占位文本。 */
export const MAX_PROMPT_IMAGE_BYTES = 16 * 1024 * 1024

export interface RenderedMessage {
  /** 纯文本版本，用于会话历史与提示词。 */
  text: string
  /** 图片附件，交给 OpenCode 作为多模态输入。 */
  files: PromptFile[]
}

export interface RenderContext {
  api: OneBotApi
  target: ChatTarget
  logger: Logger
  /** 受控临时图片存储。 */
  media: MediaStore
  /** 用户显示名缓存，避免每条消息都请求一次 API。 */
  names?: Map<string, { name: string; expires: number }>
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

/** 图片段的占位文本；收藏表情保留 NapCat 给的 summary，普通图片用 `[图片]`。 */
function imagePlaceholder(segment: MessageSegment): string {
  const data = segment.data as { summary?: string; sub_type?: unknown }
  if (!isCustomFaceImage(data)) return "[图片]"
  // summary 由表情主人撰写，属于不受信任文本，进提示词前先净化。
  const summary = typeof data.summary === "string" ? sanitizeUntrustedText(data.summary).trim() : ""
  return summary ? summary : "[收藏表情]"
}

/**
 * 渲染器能产出文本的段类型。
 *
 * 与 renderMessage / renderForwardSegments 的分支保持一致：门卫放行的类型必须能被渲染出来，
 * 否则消息会带着空文本进会话。
 */
const RENDERABLE_SEGMENT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "at",
  "face",
  "reply",
  "image",
  "record",
  "audio",
  "video",
  "file",
  "json",
  "xml",
  "markdown",
  "forward",
])

/** 判断消息是否含有值得交给模型的内容。 */
export function shouldProcess(message: readonly MessageSegment[], userId?: string): boolean {
  if (userId && mentionsUser(message, userId)) return true
  return segments(message).some((segment) => {
    if (segment.type === "text") return segment.data.text.trim().length > 0
    return RENDERABLE_SEGMENT_TYPES.has(segment.type)
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

/** 图片引用的预算：数量与原始字节总量，渲染过程中边用边扣。 */
export interface ImageBudget {
  images: number
  bytes: number
}

/** 创建一份默认图片预算。 */
export function createImageBudget(): ImageBudget {
  return { images: MAX_PROMPT_IMAGES, bytes: MAX_PROMPT_IMAGE_BYTES }
}

/** 从预算里扣掉一张图片；预算不足或单图过大时不扣。 */
function takeImage(budget: ImageBudget, file: PromptFile): boolean {
  const bytes = file.bytes ?? inlineImageBytes(file.uri)
  if (bytes > MAX_IMAGE_BYTES) return false
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
    if (!takeImage(budget, file)) continue
    kept.push(file)
  }
  return kept
}

const USER_NAME_TTL_MS = 5 * 60 * 1000

/** 查询用户显示名：群聊优先群名片，私聊使用 QQ 昵称。 */
export async function resolveUserName(ctx: RenderContext, userId: string): Promise<string> {
  if (userId === "all") return "全体成员"
  const key = `${targetKey(ctx.target)}:${userId}`
  const cached = ctx.names?.get(key)
  if (cached && cached.expires > Date.now()) return cached.name
  try {
    const info = (
      ctx.target.kind === "group"
        ? await ctx.api.getGroupMemberInfo(ctx.target.id, userId)
        : await ctx.api.getStrangerInfo(userId)
    ) as { card?: string; nickname?: string } | undefined
    const name = info?.card?.trim() || info?.nickname?.trim() || "未知用户"
    ctx.names?.set(key, { name, expires: Date.now() + USER_NAME_TTL_MS })
    return name
  } catch (error) {
    ctx.logger.warn(`获取用户信息失败 user_id=${userId}`, error)
    return "未知用户"
  }
}

interface ForwardContent {
  text: string
  images: StoredImage[]
}

interface ForwardBudget {
  nodes: number
  chars: number
}

function createForwardBudget(): ForwardBudget {
  return { nodes: MAX_FORWARD_TOTAL_NODES, chars: MAX_FORWARD_TOTAL_CHARS }
}

async function renderForwardSegments(
  ctx: RenderContext,
  message: readonly MessageSegment[],
  depth: number,
  budget: ImageBudget,
  forwardBudget: ForwardBudget,
): Promise<ForwardContent> {
  const parts: string[] = []
  const images: StoredImage[] = []
  for (const segment of segments(message)) {
    try {
      switch (segment.type) {
        case "text":
          parts.push(sanitizeUntrustedText(segment.data.text))
          break
        case "at":
          parts.push(`@${segment.data.qq} `)
          break
        case "image": {
          parts.push(imagePlaceholder(segment))
          if (budget.images <= 0) break
          await hydrateSegment(ctx.api, segment, ctx.logger)
          const url = segment.data.url || segment.data.file
          if (!url) break
          const stored = await ctx.media.storeImage(url)
          if (!stored || !takeImage(budget, stored)) break
          images.push(stored)
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
          parts.push(`[文件]${sanitizeUntrustedText(segment.data.name || segment.data.file)}`)
          break
        case "face":
          parts.push(renderFace(segment.data.id))
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
          const nested = await renderForward(ctx, segment.data.id, depth + 1, budget, forwardBudget)
          parts.push(nested.text)
          images.push(...nested.images)
          break
        }
        default:
          break
      }
    } catch (error) {
      ctx.logger.warn(`解析转发消息段失败 type=${segment.type}`, error)
      parts.push("[无法解析的消息]")
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
  forwardBudget: ForwardBudget = createForwardBudget(),
): Promise<ForwardContent> {
  if (!id) return { text: "[合并转发]", images: [] }
  if (forwardBudget.nodes <= 0 || forwardBudget.chars <= 0) {
    return { text: "[合并转发（内容过多，已截断）]", images: [] }
  }
  let nodes: { name: string; segments: MessageSegment[] }[] = []
  try {
    const data = (await ctx.api.getForwardMessage(id)) as {
      messages?: {
        sender?: { user_id?: number; nickname?: string; card?: string }
        message?: unknown[]
      }[]
    }
    nodes = (data.messages ?? []).map((entry) => ({
      name: sanitizeSenderName(
        entry.sender?.card || entry.sender?.nickname || String(entry.sender?.user_id ?? "未知用户"),
      ),
      segments: (entry.message ?? []) as MessageSegment[],
    }))
  } catch (error) {
    ctx.logger.warn(`解析合并转发失败 id=${id}`, error)
    return { text: "[合并转发（获取失败）]", images: [] }
  }
  if (nodes.length === 0) return { text: "[合并转发]", images: [] }

  const body: string[] = []
  const images: StoredImage[] = []
  let consumed = 0
  for (const node of nodes) {
    if (consumed >= MAX_FORWARD_NODES || forwardBudget.nodes <= 0 || forwardBudget.chars <= 0) {
      break
    }
    forwardBudget.nodes -= 1
    consumed += 1
    const rendered = await renderForwardSegments(ctx, node.segments, depth, budget, forwardBudget)
    const line = `${node.name}：${rendered.text || "[空消息]"}`
    const limited = truncateCodePoints(line, Math.max(0, forwardBudget.chars))
    forwardBudget.chars -= Array.from(limited).length
    body.push(limited)
    images.push(...rendered.images)
  }
  if (consumed < nodes.length) {
    body.push(`...（还有 ${nodes.length - consumed} 条）`)
  }

  let rendered = body.join("\n")
  if (Array.from(rendered).length > MAX_FORWARD_CHARS) {
    rendered = `${truncateCodePoints(rendered, MAX_FORWARD_CHARS)}\n...（合并转发过长，已截断）`
  }
  return { text: `<forward>\n${rendered}\n</forward>`, images }
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
 * 把一条 QQ 消息拆成 (纯文本, 图片附件)。
 *
 * 引用消息会展开成 ``<quote>`` 块，合并转发展开成 ``<forward>`` 块，
 * 图片既留占位文本又内联成附件，语音先转写成文字。
 *
 * `budget` 可以和调用方共享，用于让一批消息共用同一份图片预算。
 */
export async function renderMessage(
  ctx: RenderContext,
  event: MessageEvent,
  budget: ImageBudget = createImageBudget(),
): Promise<RenderedMessage> {
  const textBuffer: string[] = []
  const files: PromptFile[] = []
  const message = segments(event.message)
  const forwardBudget = createForwardBudget()
  const voiceCache = new Map<string, string>()
  let imageIndex = 0

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
          ? sanitizeSenderName(await resolveUserName(ctx, String(data.sender.user_id)))
          : "未知用户"
        const quoted = await renderForwardSegments(
          ctx,
          data.message ?? [],
          MAX_FORWARD_DEPTH,
          budget,
          forwardBudget,
        )
        quoteLines.push(`${name}：${quoted.text || "[空消息]"}`)
        for (const image of quoted.images) {
          imageIndex += 1
          files.push({ ...image, name: `qq-quote-${imageIndex}.${image.ext}` })
        }
      } catch (error) {
        ctx.logger.warn(`获取引用消息失败 id=${segment.data.id}`, error)
      }
    }
    quoteLines.push("</quote>")
    textBuffer.push(`${quoteLines.join("\n")}\n`)
  }

  for (const segment of message) {
    try {
      switch (segment.type) {
        case "text":
          textBuffer.push(sanitizeUntrustedText(segment.data.text))
          break
        case "at":
          textBuffer.push(
            `@${sanitizeSenderName(await resolveUserName(ctx, String(segment.data.qq)))} `,
          )
          break
        case "image": {
          textBuffer.push(`${imagePlaceholder(segment)} `)
          if (budget.images <= 0) break
          await hydrateSegment(ctx.api, segment, ctx.logger)
          const url = segment.data.url || segment.data.file
          if (!url) break
          const stored = await ctx.media.storeImage(url)
          if (!stored || !takeImage(budget, stored)) break
          imageIndex += 1
          files.push({ ...stored, name: `qq-image-${imageIndex}.${stored.ext}` })
          break
        }
        case "record": {
          const rawId = (segment.data as { message_id?: number | string }).message_id
          const messageId =
            rawId === undefined
              ? event.message_id
              : Number.isFinite(Number(rawId))
                ? Number(rawId)
                : undefined
          const key = String(messageId ?? "unknown")
          let voiceText = voiceCache.get(key)
          if (voiceText === undefined) {
            voiceText = await fetchVoiceText(ctx, messageId)
            voiceCache.set(key, voiceText)
          }
          textBuffer.push(voiceText ? `[语音] ${sanitizeUntrustedText(voiceText)}` : "[语音]")
          break
        }
        case "reply":
          // 已在外层 quote 块处理过
          break
        case "forward": {
          const forward = await renderForward(ctx, segment.data.id, 0, budget, forwardBudget)
          const prefix =
            textBuffer.length > 0 && !textBuffer[textBuffer.length - 1]?.endsWith("\n") ? "\n" : ""
          textBuffer.push(`${prefix}${forward.text}\n`)
          for (const image of forward.images) {
            imageIndex += 1
            files.push({
              ...image,
              name: `qq-forward-${imageIndex}.${image.ext}`,
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
          textBuffer.push(`[文件]${sanitizeUntrustedText(segment.data.name || segment.data.file)}`)
          break
        case "face":
          textBuffer.push(renderFace(segment.data.id))
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
    } catch (error) {
      ctx.logger.warn(`解析消息段失败 type=${segment.type}`, error)
      textBuffer.push("[无法解析的消息]")
    }
  }

  return { text: textBuffer.join(""), files }
}
