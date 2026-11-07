import type { MessageEvent, MessageSegment, OneBotApi } from "@naplink/naplink"
import type { ChatTarget } from "../chat"
import type { Logger } from "../logger"
import type { MediaStore } from "./media"
import { createImageBudget, renderMessage, type PromptFile, type RenderContext } from "./render"

/** 已经投递到的位置：消息 ID 与发送时间。 */
export interface HistoryPosition {
  /** 消息 ID。 */
  id: string
  /** 发送时间（秒）。 */
  time: number
}

/** 历史回填的请求参数。 */
export interface HistoryOptions {
  /** 最多补多少条历史消息。 */
  count: number
  /** 上次已经投递到的位置；只补它之后的消息。 */
  since?: HistoryPosition
  /** 本次运行已经实时处理过的消息 ID，不重复补。 */
  exclude?: ReadonlySet<string>
}

/** 历史回填的结果。 */
export interface HistoryResult {
  /** 拼在首轮消息前面的历史文本块。 */
  text: string
  /** 历史消息里的图片附件。 */
  files: PromptFile[]
}

/** 历史回填的来源，会话管理只依赖这个接口。 */
export interface HistoryProvider {
  /** 拉取目标的历史消息并渲染成文本块与附件。 */
  fetch(target: ChatTarget, options: HistoryOptions): Promise<HistoryResult>
}

/** NapCat 历史接口返回的消息结构，只取插件用得到的字段。 */
interface RawMessage {
  message_id?: number
  message_seq?: number
  time?: number
  user_id?: number
  sender?: { user_id?: number; nickname?: string; card?: string }
  message?: MessageSegment[] | string
}

/** 补齐历史时最多翻多少页，避免长时间离线时无限翻页。 */
const MAX_HISTORY_PAGES = 10

/**
 * 创建历史回填的来源。
 *
 * 群聊与私聊都要补，NapCat 的两个历史接口参数不同，这里按目标类型分派。
 */
export function createHistoryProvider(deps: {
  api: OneBotApi
  logger: Logger
  media: MediaStore
  names?: Map<string, { name: string; expires: number }>
}): HistoryProvider {
  return {
    async fetch(target, options) {
      const count = Math.max(0, Math.floor(options.count))
      if (count === 0) return { text: "", files: [] }

      const ctx: RenderContext = { ...deps, target }
      const entries = options.since
        ? await fetchGap(ctx, options.since, count, options.exclude)
        : await fetchLatest(ctx, count, options.exclude)
      if (entries.length === 0) return { text: "", files: [] }

      // 整批历史共用一份图片预算，避免单次回填塞爆上下文。
      const budget = createImageBudget()
      const lines: string[] = []
      const files: PromptFile[] = []
      for (const entry of entries) {
        const rendered = await renderMessage(ctx, toEvent(entry), budget)
        const text = rendered.text.trim()
        if (!text && rendered.files.length === 0) continue
        lines.push(`${senderName(entry)}: ${text}`)
        for (const file of rendered.files) {
          files.push({ ...file, name: `qq-history-${files.length + 1}-${file.name}` })
        }
      }
      if (lines.length === 0) return { text: "", files: [] }

      return {
        text: `<history>\n之前的聊天记录（按时间顺序）：\n${lines.join("\n")}\n</history>`,
        files,
      }
    },
  }
}

/**
 * 补最近的历史消息：新建会话时用。
 *
 * 已经在本次运行里实时处理过的消息要排除掉，否则会在首轮里重复出现。
 */
async function fetchLatest(
  ctx: RenderContext,
  count: number,
  exclude: ReadonlySet<string> | undefined,
): Promise<RawMessage[]> {
  // 多要一些，用来抵消被排除的消息。
  const wanted = count + Math.min(exclude?.size ?? 0, count)
  const entries = await requestHistory(ctx, "0", wanted)
  const fresh = exclude
    ? entries.filter((entry) => !exclude.has(String(entry.message_id)))
    : entries
  return sortByTime(fresh).slice(-count)
}

/**
 * 补上次位置之后的历史消息：从重启中恢复时用。
 *
 * NapCat 的历史接口只能往前翻（`message_seq` 取的是更早的消息），
 * 所以从最新一条开始往回翻，翻到上次位置为止；翻到的消息按时间排序后就是增量。
 */
async function fetchGap(
  ctx: RenderContext,
  since: HistoryPosition,
  count: number,
  exclude: ReadonlySet<string> | undefined,
): Promise<RawMessage[]> {
  const collected: RawMessage[] = []
  const seen = new Set<string>()
  let cursor = "0"
  let reached = false

  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const entries = await requestHistory(ctx, cursor, count)
    if (entries.length === 0) break

    let added = 0
    for (const entry of entries) {
      const id = String(entry.message_id)
      if (seen.has(id)) continue
      seen.add(id)
      collected.push(entry)
      added += 1
      if (id === since.id) reached = true
    }
    // 这一页没有新消息，说明往前翻不动了。
    if (added === 0) break
    if (reached) break

    const oldest = entries.reduce((min, entry) =>
      (entry.time ?? 0) <= (min.time ?? 0) ? entry : min,
    )
    const next = String(oldest.message_id)
    if (next === cursor) break
    cursor = next
  }

  const sorted = sortByTime(collected)
  // 命中上次位置就按位置切；没命中（位置已被清理）就按时间切。
  const start = reached
    ? sorted.findIndex((entry) => String(entry.message_id) === since.id) + 1
    : sorted.findIndex((entry) => (entry.time ?? 0) > since.time)
  const fresh = sorted.slice(start < 0 ? sorted.length : start)
  const withoutExclude = exclude
    ? fresh.filter((entry) => !exclude.has(String(entry.message_id)))
    : fresh
  return withoutExclude.slice(-count)
}

/** 请求 NapCat 的历史接口；失败或没有历史时返回空列表。 */
async function requestHistory(
  ctx: RenderContext,
  cursor: string,
  count: number,
): Promise<RawMessage[]> {
  try {
    const response =
      ctx.target.kind === "group"
        ? await ctx.api.getGroupMsgHistory({
            group_id: ctx.target.id,
            message_seq: cursor,
            count,
          })
        : await ctx.api.getFriendMsgHistory({
            user_id: ctx.target.id,
            message_seq: cursor,
            count,
          })
    return normalize(response)
  } catch (error) {
    ctx.logger.warn("拉取历史消息失败", error)
    return []
  }
}

/** NapCat 返回 `{ messages: [...] }`，兼容裸数组。 */
function normalize(response: unknown): RawMessage[] {
  if (Array.isArray(response)) return response as RawMessage[]
  if (response && typeof response === "object") {
    const messages = (response as { messages?: unknown }).messages
    if (Array.isArray(messages)) return messages as RawMessage[]
  }
  return []
}

/** 按发送时间从旧到新排序，时间相同时用消息序号稳定排序。 */
function sortByTime(entries: readonly RawMessage[]): RawMessage[] {
  return [...entries].sort(
    (a, b) => (a.time ?? 0) - (b.time ?? 0) || (a.message_seq ?? 0) - (b.message_seq ?? 0),
  )
}

/** 把历史消息拼成渲染器能吃的消息事件。 */
function toEvent(entry: RawMessage): MessageEvent {
  const message: MessageSegment[] = Array.isArray(entry.message)
    ? entry.message
    : [{ type: "text", data: { text: String(entry.message ?? "") } }]
  return {
    time: entry.time ?? 0,
    self_id: 0,
    post_type: "message",
    message_type: "private",
    sub_type: "normal",
    message_id: entry.message_id ?? 0,
    user_id: entry.user_id ?? 0,
    message,
    raw_message: "",
    font: 0,
    sender: {
      user_id: entry.sender?.user_id ?? entry.user_id,
      nickname: entry.sender?.nickname,
      card: entry.sender?.card,
    },
  }
}

/** 历史消息里的显示名，优先用群名片。 */
function senderName(entry: RawMessage): string {
  const card = entry.sender?.card?.trim()
  if (card) return card
  const nickname = entry.sender?.nickname?.trim()
  if (nickname) return nickname
  return String(entry.user_id ?? "未知用户")
}
