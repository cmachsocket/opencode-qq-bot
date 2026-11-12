import { basename } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { isTargetAllowed } from "../access"
import { delay } from "../async"
import { type ChatTarget, targetKey, targetLabel } from "../chat"
import type { QQBotConfig } from "../config"
import { dateKey, isDateKey } from "../diary/format"
import { isDiaryScopeChat } from "../diary/scope"
import type { DiaryStore } from "../diary/store"
import {
  checkDescription,
  type CollectionStore,
  DESCRIPTION_RULES,
  MAX_DESCRIPTION_LENGTH,
  type RecentImages,
} from "../emoji/collection"
import {
  CUSTOM_FACE_SUB_TYPE,
  type FavoriteStore,
  formatFavoriteIds,
  formatFavoriteList,
} from "../emoji/favorites"
import type { FavoriteIndex } from "../emoji/favorite-index"
import type { Logger } from "../logger"
import type { OutboundMedia } from "../media-path"
import { neutralizeStructureTags, sanitizeUntrustedText } from "../model-view"
import type { QQClient } from "../naplink/client"
import { splitGraphemes, splitMessage, segmentDelayMs, toPlainText } from "../outbound"
import type { RateLimitVerdict, SendRateLimiter } from "../rate-limit"
import { modelSendScope, pluginSendScope } from "../rate-limit"
import type { SensitiveChecker } from "../sensitive"
import type { SessionManager } from "../session/manager"
import type { Tracer } from "../trace"
import { softTruncate } from "../text"

/** 工具命名空间，最终工具名为 qq_send_message 等。 */
export const TOOL_NAMESPACE = "qq"

/**
 * 申请回复权限的工具名。
 *
 * 群里默认没有发送权限：模型得先说明为什么要回复，拿到权限才能发送；
 * 权限只在本轮有效。私聊默认开放，不需要申请。
 */
export const QQ_REQUEST_REPLY_TOOL = "qq_request_reply"

/**
 * 暴露给模型的 QQ 工具名。
 *
 * 上游按 `namespace_工具名` 生成对外名字（点号换成下划线），模型只认这些名字；
 * `qq_send_message` 是模型发消息的唯一入口。
 */
export const QQ_TOOL_NAMES = [
  "qq_request_reply",
  "qq_send_message",
  "qq_send_image",
  "qq_send_sticker",
  "qq_send_record",
  "qq_send_forward",
  "qq_send_poke",
  "qq_delete_message",
  "qq_favorite_list",
  "qq_collect_sticker",
  "qq_get_group_member_info",
  "qq_fetch_ptt_text",
  "qq_get_login_info",
  "qq_send_file",
  "qq_diary_write",
  "qq_diary_read",
  "qq_diary_list",
] as const

export interface ToolDeps {
  ctx: Plugin.Context
  config: QQBotConfig
  logger: Logger
  manager: SessionManager
  client: QQClient
  /** 收藏表情读写，供 qq_send_sticker 使用。 */
  favorites: FavoriteStore
  /** 收藏表情编号索引，供 qq_send_sticker 与 qq_favorite_list 使用。 */
  favoriteIndex: FavoriteIndex
  /** 本机收集的表情清单，供 qq_collect_sticker 使用。 */
  collection: CollectionStore
  /** 各聊天最近收到的图片，供 qq_collect_sticker 找素材。 */
  recentImages: RecentImages
  /** 出站限流器，所有发送类工具共用一个实例。 */
  limiter: SendRateLimiter
  /** 出站敏感信息检查，命中时整条消息不发送。 */
  sensitive: SensitiveChecker
  /** 出站媒体的路径与地址把关。 */
  outbound: OutboundMedia
  /**
   * 普通成员可用的出站媒体把关，只放开媒体目录。
   *
   * owner/admin 用 `outbound`（工作区 + 媒体目录 + 配置的额外目录），
   * 其他人只能用这个收窄过的实例，避免读到工作区里的源码与配置。
   */
  outboundMember?: OutboundMedia
  /** 日记读写，供 qq_diary_* 使用；不传就不注册日记工具。 */
  diary?: DiaryStore
  /** 调用链追踪器；不传就不记追踪。 */
  tracer?: Tracer
  /**
   * 本实例是否持有机器人连接锁。
   *
   * 没有锁说明机器上另一个实例在消费消息，这个实例不能发送。
   */
  canSend?: () => boolean
}

interface SendMessageInput {
  content?: string
  reply?: boolean
  unlimit_length?: boolean
}

interface MediaInput {
  file?: string
  base64?: string
}

interface ForwardNodeInput {
  content?: string
}

interface ForwardInput {
  nodes?: ForwardNodeInput[]
}

interface UserInput {
  user_id?: number | string
}

interface StickerInput {
  id?: number
}

interface CollectStickerInput {
  description?: string
}

interface MessageIdInput {
  message_id?: number | string
}

interface DiaryWriteInput {
  content?: string
  date?: string
  title?: string
}

interface DiaryReadInput {
  date?: string
}

interface DiaryListInput {
  days?: number
}

interface FileInput {
  file?: string
  name?: string
}

/** 合并转发里单个节点的字数上限，留出余量避免被 NapCat 截断。 */
const FORWARD_NODE_CHARS = 3000

function text(value: string, metadata?: Record<string, unknown>) {
  // 工具返回 error 文本时状态仍是 completed；把失败标记带给发送守卫。
  const marks = { ...(value.startsWith("error:") ? { failed: true } : {}), ...metadata }
  return { content: value, ...(Object.keys(marks).length > 0 ? { metadata: marks } : {}) }
}

/** 工具返回值：content 是给模型看的文本，metadata 带失败标记。 */
type ToolResult = ReturnType<typeof text>

/** 日记正文进模型上下文的固定上限，超出部分截断。 */
const DIARY_READ_MAX_CHARS = 4000

/**
 * 净化日记正文。
 *
 * 逐行净化再整体中和结构标签：日记是多段文本，
 * 整体净化会把换行压成空格，段落就没了。
 */
function sanitizeDiaryBody(body: string): string {
  const lines = String(body ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => sanitizeUntrustedText(line))
  return neutralizeStructureTags(lines.join("\n"))
}

/** 组装给模型看的日记正文：标题加正文，超长时按自然边界截断。 */
function formatDiaryBody(date: string, title: string, body: string): string {
  const plain = sanitizeDiaryBody(body)
  const clipped = softTruncate(plain, DIARY_READ_MAX_CHARS)
  return [`${date} 的日记：${sanitizeUntrustedText(title)}`, "", clipped].join("\n")
}

/** 按目标类型把消息投递出去：群聊与私聊走不同的 API。 */
function sendPayload(client: QQClient, target: ChatTarget, payload: string | unknown[]) {
  return target.kind === "group"
    ? client.api.sendGroupMessage(target.id, payload)
    : client.api.sendPrivateMessage(target.id, payload)
}

/** 从 OneBot 发送结果里取出 message_id。 */
function messageIdOf(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined
  const record = response as { message_id?: unknown; data?: { message_id?: unknown } }
  const value = record.message_id ?? record.data?.message_id
  return value === undefined || value === null ? undefined : String(value)
}

/** 插件自己发的消息同样按操作 id 分组：一次发送拆出的多段共用一个 id。 */
let plainSeq = 0
const nextPlainOperation = (): string => `plain-${++plainSeq}`

/**
 * 向一个目标发送纯文本消息，超长时按段落拆分。
 *
 * 命令、后台任务这类没有会话轮次的场景用它回消息，
 * 内容由插件自己生成，不做 markdown 剥离；
 * 发送前只做节奏控制，不会被硬上限拦下。
 */
export async function sendPlainMessage(
  client: QQClient,
  target: ChatTarget,
  content: string,
  options: { delayMs?: number; limiter: SendRateLimiter },
): Promise<number> {
  const chunks = splitMessage(content)
  const operation = nextPlainOperation()
  let sent = 0
  for (const [index, chunk] of chunks.entries()) {
    await options.limiter.pace(pluginSendScope(target), operation)
    await sendPayload(client, target, chunk)
    sent += 1
    if (index < chunks.length - 1 && (options.delayMs ?? 0) > 0) {
      await delay(options.delayMs ?? 0)
    }
  }
  return sent
}

/** 命令结果发送通道的配置。 */
export interface PlainSenderOptions {
  delayMs?: number
  limiter: SendRateLimiter
  logger: Logger
  /** 发送失败时写进日志的说明。 */
  failure: (target: ChatTarget) => string
}

/**
 * 创建命令结果的发送通道。
 *
 * 发送失败只记日志，不往上抛：命令已经执行完，不该因为回执失败再报错。
 */
export function createPlainSender(
  client: QQClient,
  options: PlainSenderOptions,
): (target: ChatTarget, content: string) => Promise<void> {
  return async (target, content) => {
    try {
      await sendPlainMessage(client, target, content, {
        delayMs: options.delayMs,
        limiter: options.limiter,
      })
    } catch (error) {
      options.logger.error(options.failure(target), error)
    }
  }
}

/**
 * 向一个目标发送本地文件。
 *
 * 路径先过出站白名单：只允许白名单目录里的普通文件，软链接指向别处也拒绝。
 * 文件内容不扫描，只看显示名与路径，避免把凭证文件指出去。
 */
export async function sendFileMessage(
  client: QQClient,
  target: ChatTarget,
  file: string,
  options: {
    /** 对方看到的文件名；不传时用真实文件名。 */
    name?: string
    limiter: SendRateLimiter
    outbound: OutboundMedia
    sensitive: SensitiveChecker
  },
): Promise<void> {
  const plan = await options.outbound.check(file)
  if (plan.kind !== "local") throw new Error("只能发送本地文件")
  const path = plan.path
  const name = options.name?.trim() || basename(path)
  const verdict = options.sensitive.check(`${name}\n${path}`)
  if (!verdict.allowed) throw new Error(verdict.reason)
  await options.limiter.pace(pluginSendScope(target), nextPlainOperation())
  await sendPayload(client, target, [{ type: "file", data: { file: path, name } }])
}

/**
 * 注册 QQ 命名空间下的工具。
 *
 * 全部工具都是对 NapCat OneBot API 的透传，
 * 只暴露消息收发与只读查询，不提供封禁/踢人等破坏性操作。
 */
export async function registerTools(deps: ToolDeps): Promise<{ dispose(): Promise<void> }> {
  const {
    ctx,
    config,
    logger,
    manager,
    client,
    favorites,
    favoriteIndex,
    collection,
    recentImages,
    limiter,
    sensitive,
    outbound,
    outboundMember,
    diary,
    tracer,
  } = deps

  /** 按当前会话角色选媒体目录范围：只有 owner/admin 能碰工作区。 */
  const mediaFor = (sessionID: string): OutboundMedia =>
    manager.currentRole(sessionID) === "owner" || manager.currentRole(sessionID) === "admin"
      ? outbound
      : (outboundMember ?? outbound)

  const requireTarget = (sessionID: string): ChatTarget | undefined => {
    const target = manager.targetForSession(sessionID)
    if (!target) return undefined
    if (!isTargetAllowed(config.access, target, config.ownerQQ)) {
      logger.warn(`${targetLabel(target)} 已不在放行名单里，拒绝工具调用`)
      return undefined
    }
    return target
  }

  /**
   * 发送前的检查：没锁、没连接都不发。
   *
   * 没锁说明这台机器上另一个实例在消费消息，本实例的通道并没有连上 NapCat，
   * 硬发只会得到「连接未建立」。连接断掉时先重连一次，重连不上就明确告诉模型。
   *
   * @returns 可以发送时返回 undefined，否则返回给模型的错误文案。
   */
  const checkSendable = async (): Promise<string | undefined> => {
    if (deps.canSend && !deps.canSend()) {
      logger.warn("本实例没有机器人连接锁，拒绝发送")
      return "error: 本实例没有机器人连接锁（这台机器上已有另一个实例在运行），消息未发送"
    }
    if (!(await client.ensureConnected())) {
      logger.error("NapCat 未连接，放弃发送")
      return "error: NapCat 未连接，消息未发送；请稍后重试"
    }
    return undefined
  }

  /**
   * 群里发消息前的权限检查。
   *
   * 默认没有发送权限：模型先说明理由才拿得到，权限只在本轮有效。
   * 私聊默认开放，不用申请；选择不回复（`reply=false`）也不需要权限。
   *
   * @returns 可以发送时返回 undefined，否则返回给模型的错误文案。
   */
  const checkReplyPermission = (sessionID: string, target: ChatTarget): string | undefined => {
    if (!config.reply.requirePermission) return undefined
    if (target.kind === "private") return undefined
    if (manager.canReply(sessionID)) return undefined
    logger.warn(`${targetLabel(target)} 本轮还没有说明回复理由，拒绝发送`, traceMeta(sessionID))
    return `error: 本轮还没有说明回复理由。要回复用户，先调用 ${QQ_REQUEST_REPLY_TOOL} 说明为什么要回复；说明之后才能调用 qq_send_message。`
  }

  // 同一次工具调用拆出的多段共用一个操作 id：段与段之间不再额外等间隔。
  let operationSeq = 0
  const nextOperation = (): string => `send-${++operationSeq}`

  /** 当前轮次的追踪 id，用于把这次发送记进调用链。 */
  const traceIdOf = (sessionID: string): string | undefined =>
    manager.activeTurn(sessionID)?.turn.traceId

  /** 日志里带上追踪 id，方便按一轮排查。 */
  const traceMeta = (sessionID: string): Record<string, unknown> => {
    const traceId = traceIdOf(sessionID)
    return traceId ? { trace_id: traceId } : {}
  }

  /** 记一个“回复已发出”的追踪节点。 */
  const traceSent = async (
    sessionID: string,
    target: ChatTarget,
    attributes: Record<string, unknown>,
  ): Promise<void> => {
    const traceId = traceIdOf(sessionID)
    if (!traceId) return
    await tracer?.record("response_sent", traceId, attributes, targetKey(target))
  }

  /**
   * 发送类工具的统一前置：解析目标，并确认本实例可以发送。
   *
   * 返回 `error` 时调用方直接把它交给模型；否则 `target` 一定存在。
   */
  const prepareSend = async (
    sessionID: string,
  ): Promise<
    { target: ChatTarget; error?: undefined } | { target?: undefined; error: ToolResult }
  > => {
    const target = requireTarget(sessionID)
    if (!target) return { error: text("error: 当前会话没有绑定 QQ 群聊或私聊") }
    const blocked = await checkSendable()
    if (blocked) return { error: text(blocked) }
    return { target }
  }

  /**
   * 只读类工具的统一前置：只解析目标，不要求连接可用。
   *
   * 查资料不需要发消息，连接断着也能回答。
   */
  const prepareQuery = (
    sessionID: string,
  ): { target: ChatTarget; error?: undefined } | { target?: undefined; error: ToolResult } => {
    const target = requireTarget(sessionID)
    if (!target) return { error: text("error: 当前会话没有绑定 QQ 群聊或私聊") }
    return { target }
  }

  /** 记下机器人自己发出的消息 ID，供撤回与重复检测使用。 */
  const trackSent = (target: ChatTarget, response: unknown): void => {
    const messageId = messageIdOf(response)
    if (messageId) manager.rememberOutgoing(target, messageId)
  }

  /**
   * 申请一次出站发送许可。
   *
   * 超出每分钟 / 每小时上限时拒绝这次发送，并把原因回给模型，
   * 让它立刻停下，而不是把群刷爆。
   */
  const permit = async (target: ChatTarget, operation: string): Promise<RateLimitVerdict> => {
    const verdict = await limiter.acquire(modelSendScope(target), operation)
    if (!verdict.allowed) logger.warn(`${targetLabel(target)} 出站限流：${verdict.reason}`)
    return verdict
  }

  /** 限流拒绝时的工具返回值：本轮算已回复，避免模型被反复提醒补发。 */
  const refuse = (sessionID: string, verdict: RateLimitVerdict, sent = 0, total = 0) => {
    manager.markMessageSent(sessionID)
    const progress = total > 0 ? `（已发送 ${sent}/${total} 段）` : ""
    // 限流拒绝是“请停止发送”，不要因为它允许模型立刻重试。
    return text(`error: ${verdict.reason}${progress}`, { retryable: false })
  }

  /**
   * 出站前的敏感信息检查。
   *
   * 命中时抛错而不是返回 error 文本：发送守卫会因此解除“已发送”标记，
   * 本轮也不会算作已回复，模型可以删掉凭证后立刻重发。
   */
  const guardOutbound = (target: ChatTarget, content: string): void => {
    const verdict = sensitive.check(content)
    if (verdict.allowed) return
    const detectors = verdict.hits.map((hit) => hit.detector).join("、")
    logger.warn(`${targetLabel(target)} 出站消息包含敏感信息，已拦截：${detectors}`)
    throw new Error(verdict.reason)
  }

  /** base64:// 载荷是二进制数据，按文本扫描既没意义也慢。 */
  const isInlineData = (value: string): boolean => value.startsWith("base64://")

  /** 内联数据解码后的大小上限：5MB。 */
  const MAX_INLINE_BYTES = 5 * 1024 * 1024

  /** base64 每 4 个字符解出 3 字节，字符上限按这个比例算。 */
  const MAX_INLINE_CHARS = Math.ceil((MAX_INLINE_BYTES * 4) / 3)

  /**
   * 内联数据的大小检查。
   *
   * 内联数据不经过路径与网络校验，超大载荷会把内存和对端一起撑爆，这里直接拒掉。
   */
  const checkInlineSize = (value: string, kind: string): string | undefined => {
    if (!isInlineData(value)) return undefined
    if (value.length <= MAX_INLINE_CHARS) return undefined
    return `error: ${kind}数据过大，超过 ${Math.floor(MAX_INLINE_BYTES / 1024 / 1024)}MB 上限`
  }

  const send = (target: ChatTarget, payload: string | unknown[]) =>
    sendPayload(client, target, payload)

  const sendForward = (target: ChatTarget, nodes: unknown[]) =>
    target.kind === "group"
      ? client.api.sendGroupForwardMessage(target.id, nodes)
      : client.api.sendPrivateForwardMessage({ user_id: target.id, messages: nodes })

  const sendPoke = (target: ChatTarget, userId: string | number) =>
    target.kind === "group"
      ? client.api.sendGroupPoke(target.id, userId)
      : client.api.sendFriendPoke(userId)

  // 合并转发时机器人自己的昵称，取一次就够。
  let botName: string | undefined

  /** 机器人在合并转发里的身份。 */
  const botIdentity = async (): Promise<{ userId: number; nickname: string }> => {
    if (!botName) {
      const info = (await client.api.getLoginInfo().catch(() => undefined)) as
        { nickname?: string } | undefined
      botName = info?.nickname?.trim() || "机器人"
    }
    const userId = Number(client.selfId ?? 0)
    return { userId: Number.isFinite(userId) ? userId : 0, nickname: botName }
  }

  /**
   * 太长的回复改成合并转发发出去。
   *
   * 一口气刷十几条会把群刷爆，合并转发只占一条消息。
   */
  const sendAsForward = async (
    sessionID: string,
    target: ChatTarget,
    plain: string,
    operation: string,
    length: number,
  ) => {
    const label = targetLabel(target)
    const identity = await botIdentity()
    const nodes = splitMessage(plain, FORWARD_NODE_CHARS).map((chunk) => ({
      user_id: identity.userId,
      nickname: identity.nickname,
      content: [{ type: "text", data: { text: chunk } }],
    }))
    try {
      const verdict = await permit(target, operation)
      if (!verdict.allowed) return refuse(sessionID, verdict, 0, nodes.length)
      const response = await sendForward(target, nodes)
      trackSent(target, response)
      manager.markMessageSent(sessionID)
      logger.info(
        `${label} 已发送 ${length} 字（合并转发 ${nodes.length} 个节点）`,
        traceMeta(sessionID),
      )
      await traceSent(sessionID, target, { chars: length, mode: "forward", nodes: nodes.length })
      return text("你已成功发送消息，可以选择结束对话")
    } catch (error) {
      logger.error(`${label} 发送合并转发失败`, error)
      return text("error: 消息发送失败", { retryable: true })
    }
  }

  const result = await ctx.tool.transform((editor) => {
    editor.namespace({
      name: TOOL_NAMESPACE,
      description:
        "QQ 聊天工具：发送消息、图片、语音、合并转发，以及查询用户信息。仅在 QQ 群聊或私聊会话里可用，其他会话调用会返回错误。",
    })
    // 模型按这些名字调用工具；名字对不上时模型只会说「找不到工具」。
    logger.info("已注册 QQ 工具", { tools: [...QQ_TOOL_NAMES] })

    // QQ 工具必须作为独立工具暴露。Code Mode 只给模型一个 execute，
    // 按聊天配置的 qq_* 规则永远命不中，普通成员会连发消息的能力都没有。

    editor.add({
      name: "request_reply",
      description:
        "说明本轮为什么要回复。群里按约定不主动发言：要回复用户，先调用这个工具并说明为什么要回复，说明之后才能调用 qq_send_message；这个约定只在本轮有效，轮次结束就作废。私聊默认直接回复，不用说明。",
      input: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "为什么要回复这条消息（必填）：说清楚回复的理由，不要只写「需要回复」",
          },
        },
        required: ["reason"],
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE, codemode: false },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as { reason?: unknown }
        const reason = typeof input.reason === "string" ? input.reason.trim() : ""
        if (!reason) return text("error: 必须说明为什么回复（reason 不能为空）")
        const target = manager.targetForSession(context.sessionID)
        if (!target) return text("error: 当前会话没有绑定 QQ 群聊或私聊")
        const granted = manager.requestReply(context.sessionID, reason)
        if (!granted.granted) {
          return text("error: 当前没有进行中的 QQ 消息轮次，说不了回复理由")
        }
        if (target.kind === "private") {
          return text("私聊默认就直接回复，不用说明理由。")
        }
        return text(
          `已按约定说明本轮回复理由（理由：${reason}）。现在可以调用 qq_send_message 回复；这个约定只在本轮有效。`,
        )
      },
    })

    editor.add({
      name: "send_message",
      description:
        "向当前 QQ 群聊或私聊发送一条消息。每轮必须调用一个发送工具。content: 要发送的文本；reply: true 表示发送，false 表示选择不发送（已读不回）；unlimit_length: 设为 true 可解除默认的长度告警限制。",
      input: {
        type: "object",
        properties: {
          content: { type: "string", description: "要发送的文本内容；reply=false 时可省略" },
          reply: { type: "boolean", description: "true 表示发送，false 表示本轮不回复" },
          unlimit_length: { type: "boolean", description: "解除默认的消息长度限制" },
        },
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE, codemode: false },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as SendMessageInput
        const prepared = await prepareSend(context.sessionID)
        if (prepared.error) return prepared.error
        const target = prepared.target
        const label = targetLabel(target)

        if (input.reply === false) {
          logger.info(`${label} 模型选择不回复`)
          manager.markMessageSent(context.sessionID)
          return text("skipped")
        }
        const content = (input.content ?? "").trim()
        if (!content) {
          logger.info(`${label} 回复内容为空`)
          manager.markMessageSent(context.sessionID)
          return text("skipped")
        }

        // 模型偶尔不听话写 markdown，剥成纯文本再发出去。
        const plain = toPlainText(content).trim()
        if (!plain) {
          logger.info(`${label} 回复内容剥离后为空`)
          manager.markMessageSent(context.sessionID)
          return text("skipped")
        }
        const denied = checkReplyPermission(context.sessionID, target)
        if (denied) return text(denied)
        guardOutbound(target, plain)

        // 长度按字素簇算，和拆段的口径一致：一个 emoji 只算一个。
        const length = splitGraphemes(plain).length
        if (length > config.warnLength && input.unlimit_length !== true) {
          logger.warn(`send_message 内容长度 ${length} 超过 ${config.warnLength}`)
        }

        const operation = nextOperation()
        // 太长的回复改成合并转发，别一口气刷屏。
        const forwardThreshold = config.reply.forwardThresholdChars
        if (forwardThreshold > 0 && length > forwardThreshold) {
          return await sendAsForward(context.sessionID, target, plain, operation, length)
        }

        // 单段超过配置的字数就拆成多段发。
        const chunks = splitMessage(plain, config.reply.segmentChars)
        // 剩余额度不够分段时，宁可合并转发一条，也不要把回复截成半截。
        if (forwardThreshold > 0 && chunks.length > limiter.remaining(modelSendScope(target))) {
          return await sendAsForward(context.sessionID, target, plain, operation, length)
        }
        // 段与段之间的间隔：配了随机区间就在区间里等。
        const wait = segmentDelayMs({
          sendDelayMs: config.sendDelayMs,
          minDelayMs: config.reply.minDelayMs,
          maxDelayMs: config.reply.maxDelayMs,
        })
        let sent = 0
        try {
          for (const [index, chunk] of chunks.entries()) {
            const verdict = await permit(target, operation)
            if (!verdict.allowed) return refuse(context.sessionID, verdict, sent, chunks.length)
            const response = await send(target, chunk)
            trackSent(target, response)
            sent += 1
            if (index < chunks.length - 1 && wait > 0) {
              await delay(wait)
            }
          }
        } catch (error) {
          if (sent > 0) manager.markMessageSent(context.sessionID)
          logger.error(`${label} 发送消息失败，已发送 ${sent}/${chunks.length} 段`, error)
          // 已经发出部分段落时不要允许整条重试，否则会重复发送。
          return text(`error: 消息只发送了 ${sent}/${chunks.length} 段`, { retryable: sent === 0 })
        }
        manager.markMessageSent(context.sessionID)
        logger.info(`${label} 已发送 ${length} 字`, traceMeta(context.sessionID))
        await traceSent(context.sessionID, target, { chars: length, mode: "plain", segments: sent })
        return text("你已成功发送消息，可以选择结束对话")
      },
    })

    editor.add({
      name: "send_image",
      description:
        "向当前 QQ 群聊或私聊发送一张图片。file 可以是本地路径或 http(s) 图片地址；base64 传 base64:// 形式的数据。本地路径：owner/admin 可取工作目录、媒体目录和配置放开的目录，普通成员只能取媒体目录；http(s) 地址只允许公网地址。",
      input: {
        type: "object",
        properties: {
          file: { type: "string", description: "本地文件路径或图片 URL" },
          base64: { type: "string", description: "base64 编码的图片数据" },
        },
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE, codemode: false },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as MediaInput
        const prepared = await prepareSend(context.sessionID)
        if (prepared.error) return prepared.error
        const target = prepared.target
        const denied = checkReplyPermission(context.sessionID, target)
        if (denied) return text(denied)
        const file = input.file ?? (input.base64 ? `base64://${input.base64}` : undefined)
        if (!file) return text("error: 缺少 file 或 base64")
        const tooLarge = checkInlineSize(file, "图片")
        if (tooLarge) return text(tooLarge)
        if (!isInlineData(file)) guardOutbound(target, file)
        // 路径白名单在这里就判定：不过就不占发送额度。内联数据不涉及路径与网络。
        const mediaCheck = mediaFor(context.sessionID)
        const plan = isInlineData(file) ? undefined : await mediaCheck.check(file)
        const verdict = await permit(target, nextOperation())
        if (!verdict.allowed) return refuse(context.sessionID, verdict)
        const media = plan ? mediaCheck.materialize(plan) : file
        const response = await send(target, [{ type: "image", data: { file: media } }])
        trackSent(target, response)
        manager.markMessageSent(context.sessionID)
        return text("你已成功发送图片，可以选择结束对话")
      },
    })

    editor.add({
      name: "favorite_list",
      description:
        "列出收藏表情（表情包）的编号与标签，编号用于 qq_send_sticker 发送。本机收集的表情也在列表里，标注为「本机收藏」。",
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE, codemode: false },
      execute: async (_raw, context) => {
        const prepared = prepareQuery(context.sessionID)
        if (prepared.error) return prepared.error
        const faces = await favorites.list()
        const rows = await favoriteIndex.sync(faces, await collection.list())
        return text(formatFavoriteList(rows))
      },
    })

    editor.add({
      name: "collect_sticker",
      description: [
        "收藏当前聊天里最近收到的一张动画表情（GIF 动图），收进收藏夹；",
        "收藏后用 qq_send_sticker 按编号把它发回聊天。",
        `description 必填：给这个表情起一个中文名字。${DESCRIPTION_RULES}`,
      ].join(""),
      input: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: `收藏描述：中文名字，最多 ${MAX_DESCRIPTION_LENGTH} 个字，只用文字和数字，不要标点、空格、引号、解释（必填）`,
          },
        },
        required: ["description"],
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE, codemode: false },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as CollectStickerInput
        const prepared = prepareQuery(context.sessionID)
        if (prepared.error) return prepared.error
        const target = prepared.target
        const checked = checkDescription(input.description)
        if (!checked.ok) return text(`error: ${checked.reason}。${DESCRIPTION_RULES}`)
        const image = recentImages.latest(target, { animated: true })
        if (!image) {
          return text("error: 这个聊天最近没有收到动画表情（GIF 动图），无法收藏")
        }
        let sticker
        try {
          sticker = await collection.add(image.file, checked.value)
        } catch (error) {
          logger.warn("收藏表情失败", error)
          return text(`error: 收藏失败：${error instanceof Error ? error.message : String(error)}`)
        }
        const faces = await favorites.list()
        const rows = await favoriteIndex.sync(faces, await collection.list())
        // 同一张图本来就在 QQ 收藏里时，编号归那条收藏表情。
        const row = rows.find((item) => {
          const md5 = item.collected?.md5 ?? String(item.face.md5 ?? "").toLowerCase()
          return md5 === sticker.md5
        })
        const age = Math.max(0, Math.round((Date.now() - image.at) / 1000))
        return text(
          `已收藏「${sticker.description}」，编号 ${row?.id ?? "未知"}（来自 ${age} 秒前收到的动图），之后用 qq_send_sticker 按编号发送。`,
        )
      },
    })

    editor.add({
      name: "send_sticker",
      description:
        "发送一张收藏表情（表情包）。id 是收藏表情编号，先用 qq_favorite_list 查看编号与标签的对应关系。",
      input: {
        type: "object",
        properties: {
          id: { type: "number", description: "收藏表情编号" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE, codemode: false },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as StickerInput
        const prepared = await prepareSend(context.sessionID)
        if (prepared.error) return prepared.error
        const target = prepared.target
        const denied = checkReplyPermission(context.sessionID, target)
        if (denied) return text(denied)
        const id = input.id
        if (typeof id !== "number" || !Number.isInteger(id)) {
          return text("error: 缺少 id（收藏表情编号）")
        }
        const faces = await favorites.list()
        const rows = await favoriteIndex.sync(faces, await collection.list())
        const row = rows.find((item) => item.id === id)
        if (!row) {
          return text(`error: 没有找到编号 ${id} 的收藏表情，可用编号：${formatFavoriteIds(rows)}`)
        }
        const url = typeof row.face.url === "string" ? row.face.url : undefined
        if (!url) return text(`error: 编号 ${id} 的收藏表情缺少可用地址`)
        guardOutbound(target, url)
        // 收藏表情的地址同样来自外部，要走和图片一致的路径与地址白名单。
        let plan
        try {
          plan = await outbound.check(url)
        } catch (error) {
          return text(`error: ${error instanceof Error ? error.message : String(error)}`)
        }
        const verdict = await permit(target, nextOperation())
        if (!verdict.allowed) return refuse(context.sessionID, verdict)
        // QQ 收藏表情带 sub_type=1（KCUSTOM）；本机收集的表情不在 QQ 收藏里，按普通图片发。
        const data: { file: string; sub_type?: number } = { file: outbound.materialize(plan) }
        if (!row.collected) data.sub_type = CUSTOM_FACE_SUB_TYPE
        const response = await send(target, [{ type: "image", data }])
        trackSent(target, response)
        manager.markMessageSent(context.sessionID)
        return text(`你已成功发送收藏表情 ${id}「${row.tag || "未标注"}」，可以选择结束对话`)
      },
    })

    editor.add({
      name: "send_record",
      description:
        "向当前 QQ 群聊或私聊发送一条语音。file 可以是本地路径或 http(s) 音频地址。本地路径：owner/admin 可取工作目录、媒体目录和配置放开的目录，普通成员只能取媒体目录；http(s) 地址只允许公网地址。",
      input: {
        type: "object",
        properties: {
          file: { type: "string", description: "本地文件路径或音频 URL" },
        },
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE, codemode: false },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as MediaInput
        const prepared = await prepareSend(context.sessionID)
        if (prepared.error) return prepared.error
        const target = prepared.target
        const denied = checkReplyPermission(context.sessionID, target)
        if (denied) return text(denied)
        if (!input.file) return text("error: 缺少 file")
        const tooLarge = checkInlineSize(input.file, "语音")
        if (tooLarge) return text(tooLarge)
        if (!isInlineData(input.file)) guardOutbound(target, input.file)
        const mediaCheck = mediaFor(context.sessionID)
        const plan = isInlineData(input.file) ? undefined : await mediaCheck.check(input.file)
        const verdict = await permit(target, nextOperation())
        if (!verdict.allowed) return refuse(context.sessionID, verdict)
        const media = plan ? mediaCheck.materialize(plan) : input.file
        const response = await send(target, [{ type: "record", data: { file: media } }])
        trackSent(target, response)
        manager.markMessageSent(context.sessionID)
        return text("你已成功发送语音，可以选择结束对话")
      },
    })

    editor.add({
      name: "send_forward",
      description:
        "向当前 QQ 群聊或私聊发送一条合并转发消息。nodes 为节点列表，每个节点只包含纯文本 content；发送者统一显示为机器人自己。",
      input: {
        type: "object",
        properties: {
          nodes: {
            type: "array",
            description: "合并转发的节点列表",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "节点文本内容" },
              },
              required: ["content"],
              additionalProperties: false,
            },
          },
        },
        required: ["nodes"],
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE, codemode: false },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as ForwardInput
        const prepared = await prepareSend(context.sessionID)
        if (prepared.error) return prepared.error
        const target = prepared.target
        const denied = checkReplyPermission(context.sessionID, target)
        if (denied) return text(denied)
        const identity = await botIdentity()
        const nodes: {
          user_id: number
          nickname: string
          content: { type: string; data: { text: string } }[]
        }[] = []
        for (const node of input.nodes ?? []) {
          const body = toPlainText(node.content ?? "").trim()
          // 合并转发里每段都要扫：昵称由插件固定，模型只能控制正文。
          guardOutbound(target, body)
          nodes.push({
            user_id: identity.userId,
            nickname: identity.nickname,
            content: [{ type: "text", data: { text: body } }],
          })
        }
        if (nodes.length === 0) return text("error: nodes 为空")
        const verdict = await permit(target, nextOperation())
        if (!verdict.allowed) return refuse(context.sessionID, verdict)
        const response = await sendForward(target, nodes)
        trackSent(target, response)
        manager.markMessageSent(context.sessionID)
        await traceSent(context.sessionID, target, { mode: "forward", nodes: nodes.length })
        return text("你已成功发送合并转发消息，可以选择结束对话")
      },
    })

    editor.add({
      name: "send_poke",
      description: "在当前 QQ 会话戳一下某个用户。",
      input: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "被戳的 QQ 号" },
        },
        required: ["user_id"],
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE, codemode: false },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as UserInput
        const prepared = await prepareSend(context.sessionID)
        if (prepared.error) return prepared.error
        const target = prepared.target
        const denied = checkReplyPermission(context.sessionID, target)
        if (denied) return text(denied)
        if (!input.user_id) return text("error: 缺少 user_id")
        const verdict = await permit(target, nextOperation())
        if (!verdict.allowed) return refuse(context.sessionID, verdict)
        await sendPoke(target, input.user_id)
        manager.markMessageSent(context.sessionID)
        return text("你已成功戳一下用户，可以选择结束对话")
      },
    })

    editor.add({
      name: "delete_message",
      description: "撤回一条机器人自己发过的消息。",
      input: {
        type: "object",
        properties: {
          message_id: { type: "string", description: "要撤回的消息 ID" },
        },
        required: ["message_id"],
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE, codemode: false },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as MessageIdInput
        const prepared = await prepareSend(context.sessionID)
        if (prepared.error) return prepared.error
        const target = prepared.target
        const denied = checkReplyPermission(context.sessionID, target)
        if (denied) return text(denied)
        if (input.message_id === undefined) return text("error: 缺少 message_id")
        if (!manager.isOutgoing(target, String(input.message_id))) {
          return text("error: 只能撤回机器人自己发送过的消息")
        }
        await client.api.deleteMessage(input.message_id)
        return text("deleted")
      },
    })

    editor.add({
      name: "get_group_member_info",
      description: "查询用户资料：群聊返回群名片与昵称，私聊返回 QQ 昵称。",
      input: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "QQ 号" },
        },
        required: ["user_id"],
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE, codemode: false },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as UserInput
        const prepared = prepareQuery(context.sessionID)
        if (prepared.error) return prepared.error
        const target = prepared.target
        if (!input.user_id) return text("error: 缺少 user_id")
        const info =
          target.kind === "group"
            ? await client.api.getGroupMemberInfo(target.id, input.user_id)
            : await client.api.getStrangerInfo(input.user_id)
        return text(JSON.stringify(info))
      },
    })

    editor.add({
      name: "fetch_ptt_text",
      description: "把一条语音消息转写成文字。",
      input: {
        type: "object",
        properties: {
          message_id: { type: "string", description: "语音消息的 ID" },
        },
        required: ["message_id"],
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE, codemode: false },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as MessageIdInput
        const prepared = prepareQuery(context.sessionID)
        if (prepared.error) return prepared.error
        const target = prepared.target
        if (input.message_id === undefined) return text("error: 缺少 message_id")
        if (!manager.isKnownMessage(target, String(input.message_id))) {
          return text("error: 只能转写当前会话最近收到的消息")
        }
        const result = await client.api.fetchPttText(input.message_id)
        return text(result?.text ?? "")
      },
    })

    editor.add({
      name: "get_login_info",
      description: "获取机器人自身的 QQ 号与昵称。",
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE, codemode: false },
      execute: async (_raw, context) => {
        const prepared = prepareQuery(context.sessionID)
        if (prepared.error) return prepared.error
        const info = await client.api.getLoginInfo()
        return text(JSON.stringify(info))
      },
    })

    // 日记工具依赖日记存储；没配存储时不注册，免得模型调到一个必然失败的工具。
    const diaryStore = diary
    if (diaryStore) {
      /**
       * 日记工具的目标：必须是 owner 自己的私聊，且在当前放行名单里。
       *
       * owner 与 admin 共用 admin 配置档，只在配置里收权限不够，
       * 这里按会话实际角色再判一次。
       */
      const diaryTarget = (sessionID: string): ChatTarget | undefined => {
        const target = requireTarget(sessionID)
        if (!target) return undefined
        if (!isDiaryScopeChat(config, target)) {
          logger.warn(`${targetLabel(target)} 不是日记作用域，拒绝日记工具调用`)
          return undefined
        }
        if (manager.currentRole(sessionID) !== "owner") {
          logger.warn(`${targetLabel(target)} 不是 owner，拒绝日记工具调用`)
          return undefined
        }
        return target
      }

      /** 找不到日记时把可用的日期一起回给模型，省得它来回试。 */
      const diaryMissing = async (chat: string, date: string): Promise<string> => {
        const available = (await diaryStore.list(chat, 10)).map((item) => item.date)
        const hint = available.length > 0 ? `（可用的日期：${available.join("、")}）` : ""
        return `error: 没有找到 ${date} 的日记${hint}`
      }

      editor.add({
        name: "diary_write",
        description:
          "给当前 QQ 群聊或私聊写一篇日记。同一个聊天同一天只有一篇日记，重复写会覆盖当天那一篇。content 是日记正文；date 是日期，格式 YYYY-MM-DD，省略表示今天；title 是标题，省略时用日期做标题。",
        input: {
          type: "object",
          properties: {
            content: { type: "string", description: "日记正文（必填）" },
            date: { type: "string", description: "日期，格式 YYYY-MM-DD；省略表示今天" },
            title: { type: "string", description: "日记标题；省略时用日期做标题" },
          },
          required: ["content"],
          additionalProperties: false,
        },
        options: { namespace: TOOL_NAMESPACE, codemode: false },
        execute: async (raw, context) => {
          const input = (raw ?? {}) as DiaryWriteInput
          const target = diaryTarget(context.sessionID)
          if (!target) return text("error: 日记只在 owner 自己的私聊里可用")
          const content = (input.content ?? "").trim()
          if (!content) return text("error: 缺少 content")
          const date = input.date?.trim() || dateKey()
          if (!isDateKey(date)) return text(`error: 日期格式不对：${date}，请用 YYYY-MM-DD`)
          const entry = await diaryStore.write(targetKey(target), date, {
            title: input.title?.trim() ?? "",
            body: content,
            source: "model",
          })
          return text(`已写入 ${date} 的日记：${entry.title}`)
        },
      })

      editor.add({
        name: "diary_read",
        description:
          "读取当前 QQ 群聊或私聊的日记正文。date 是日期，格式 YYYY-MM-DD；省略时返回最近一篇。返回的是日记文本，不是文件列表。",
        input: {
          type: "object",
          properties: {
            date: { type: "string", description: "日期，格式 YYYY-MM-DD；省略表示最近一篇" },
          },
          additionalProperties: false,
        },
        options: { namespace: TOOL_NAMESPACE, codemode: false },
        execute: async (raw, context) => {
          const input = (raw ?? {}) as DiaryReadInput
          const target = diaryTarget(context.sessionID)
          if (!target) return text("error: 日记只在 owner 自己的私聊里可用")
          const chat = targetKey(target)
          const date = input.date?.trim()
          if (!date) {
            const latest = await diaryStore.latest(chat)
            if (!latest) return text("error: 这个聊天还没有日记")
            return text(formatDiaryBody(latest.date, latest.title, latest.body))
          }
          if (!isDateKey(date)) return text(`error: 日期格式不对：${date}，请用 YYYY-MM-DD`)
          const entry = await diaryStore.read(chat, date)
          if (!entry) return text(await diaryMissing(chat, date))
          return text(formatDiaryBody(entry.date, entry.title, entry.body))
        },
      })

      editor.add({
        name: "diary_list",
        description:
          "列出当前 QQ 群聊或私聊最近的日记，只返回日期和标题。days 是看几篇，默认 7 篇。",
        input: {
          type: "object",
          properties: {
            days: { type: "number", description: "看最近几篇，默认 7" },
          },
          additionalProperties: false,
        },
        options: { namespace: TOOL_NAMESPACE, codemode: false },
        execute: async (raw, context) => {
          const input = (raw ?? {}) as DiaryListInput
          const target = diaryTarget(context.sessionID)
          if (!target) return text("error: 日记只在 owner 自己的私聊里可用")
          const days = Number.isInteger(input.days) && (input.days ?? 0) > 0 ? (input.days ?? 7) : 7
          const entries = await diaryStore.list(targetKey(target), days)
          if (entries.length === 0) return text("这个聊天还没有日记。")
          return text(entries.map((entry) => `${entry.date} ${entry.title}`).join("\n"))
        },
      })
    }

    editor.add({
      name: "send_file",
      description:
        "向当前 QQ 群聊或私聊发送一个本地文件。file 是文件路径，只能是机器人允许发送的目录里的普通文件；owner/admin 可用工作目录、媒体目录和配置放开的目录，普通成员只能用媒体目录；name 是对方看到的文件名，省略时用原文件名。",
      input: {
        type: "object",
        properties: {
          file: { type: "string", description: "本地文件路径（必填）" },
          name: { type: "string", description: "对方看到的文件名；省略时用原文件名" },
        },
        required: ["file"],
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE, codemode: false },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as FileInput
        const prepared = await prepareSend(context.sessionID)
        if (prepared.error) return prepared.error
        const target = prepared.target
        const denied = checkReplyPermission(context.sessionID, target)
        if (denied) return text(denied)
        const file = input.file?.trim()
        if (!file) return text("error: 缺少 file")
        let plan
        try {
          plan = await mediaFor(context.sessionID).check(file)
        } catch (error) {
          return text(`error: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (plan.kind !== "local") return text("error: 只能发送本地文件")
        const path = plan.path
        const name = input.name?.trim() || basename(path)
        // 文件内容没法扫描，路径与显示名同样过一遍出站检查。
        guardOutbound(target, `${name}\n${path}`)
        const verdict = await permit(target, nextOperation())
        if (!verdict.allowed) return refuse(context.sessionID, verdict)
        const response = await send(target, [{ type: "file", data: { file: path, name } }])
        trackSent(target, response)
        manager.markMessageSent(context.sessionID)
        return text("你已成功发送文件，可以选择结束对话")
      },
    })
  })

  // 注册完成后与清单核对一次：新增工具忘了登记，模型就会看到不存在的名字。
  try {
    const expected = new Set<string>(QQ_TOOL_NAMES)
    const actual = (await ctx.tool.list())
      .map((tool) => tool.id)
      .filter((id) => id.startsWith("qq_"))
    // 清单里一个 qq_ 工具都看不到，说明这次 transform 还没落到注册表上：这时候比不出结果。
    if (actual.length === 0) return result
    const missing = [...expected].filter((id) => !actual.includes(id))
    const extra = actual.filter((id) => !expected.has(id))
    if (missing.length > 0 || extra.length > 0) {
      logger.warn("QQ 工具清单与实际注册不一致", { missing, extra })
    }
  } catch (error) {
    logger.warn("QQ 工具清单校验失败", error)
  }

  return result
}
