import type { Plugin } from "@opencode/plugin"
import { isTargetAllowed } from "../access"
import { delay } from "../async"
import { type ChatTarget, targetKey, targetLabel } from "../chat"
import type { QQBotConfig } from "../config"
import {
  CUSTOM_FACE_SUB_TYPE,
  type FavoriteStore,
  formatFavoriteIds,
  formatFavoriteList,
} from "../emoji/favorites"
import type { FavoriteIndex } from "../emoji/favorite-index"
import type { Logger } from "../logger"
import type { OutboundMedia } from "../media-path"
import type { QQClient } from "../naplink/client"
import { splitGraphemes, splitMessage, segmentDelayMs, toPlainText } from "../outbound"
import type { RateLimitVerdict, SendRateLimiter } from "../rate-limit"
import { modelSendScope, pluginSendScope } from "../rate-limit"
import type { SensitiveChecker } from "../sensitive"
import type { SessionManager } from "../session/manager"
import type { Tracer } from "../trace"

/** 工具命名空间，最终工具名为 qq_send_message 等。 */
export const TOOL_NAMESPACE = "qq"

/**
 * 暴露给模型的 QQ 工具名。
 *
 * 上游按 `namespace_工具名` 生成对外名字（点号换成下划线），模型只认这些名字；
 * `qq_send_message` 是模型发消息的唯一入口。
 */
export const QQ_TOOL_NAMES = [
  "qq_send_message",
  "qq_send_image",
  "qq_send_sticker",
  "qq_send_record",
  "qq_send_forward",
  "qq_send_poke",
  "qq_delete_message",
  "qq_favorite_list",
  "qq_get_group_member_info",
  "qq_fetch_ptt_text",
  "qq_get_login_info",
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
  /** 出站限流器，所有发送类工具共用一个实例。 */
  limiter: SendRateLimiter
  /** 出站敏感信息检查，命中时整条消息不发送。 */
  sensitive: SensitiveChecker
  /** 出站媒体的路径与地址把关。 */
  outbound: OutboundMedia
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
  user_id?: number | string
  nickname?: string
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

interface MessageIdInput {
  message_id?: number | string
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
    limiter,
    sensitive,
    outbound,
    tracer,
  } = deps

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

  return await ctx.tool.transform((editor) => {
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
        "向当前 QQ 群聊或私聊发送一张图片。file 可以是本地路径或 http(s) 图片地址；base64 传 base64:// 形式的数据。本地路径只能取自机器人工作目录、媒体目录和配置放开的目录；http(s) 地址只允许公网地址。",
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
        const file = input.file ?? (input.base64 ? `base64://${input.base64}` : undefined)
        if (!file) return text("error: 缺少 file 或 base64")
        const tooLarge = checkInlineSize(file, "图片")
        if (tooLarge) return text(tooLarge)
        if (!isInlineData(file)) guardOutbound(target, file)
        // 路径白名单在这里就判定：不过就不占发送额度。内联数据不涉及路径与网络。
        const plan = isInlineData(file) ? undefined : await outbound.check(file)
        const verdict = await permit(target, nextOperation())
        if (!verdict.allowed) return refuse(context.sessionID, verdict)
        const media = plan ? outbound.materialize(plan) : file
        const response = await send(target, [{ type: "image", data: { file: media } }])
        trackSent(target, response)
        manager.markMessageSent(context.sessionID)
        return text("你已成功发送图片，可以选择结束对话")
      },
    })

    editor.add({
      name: "favorite_list",
      description: "列出收藏表情（表情包）的编号与标签，编号用于 qq_send_sticker 发送。",
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE, codemode: false },
      execute: async () => {
        const faces = await favorites.list()
        const rows = await favoriteIndex.sync(faces)
        return text(formatFavoriteList(rows))
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
        const id = input.id
        if (typeof id !== "number" || !Number.isInteger(id)) {
          return text("error: 缺少 id（收藏表情编号）")
        }
        const faces = await favorites.list()
        const rows = await favoriteIndex.sync(faces)
        const row = rows.find((item) => item.id === id)
        if (!row) {
          return text(`error: 没有找到编号 ${id} 的收藏表情，可用编号：${formatFavoriteIds(rows)}`)
        }
        const url = typeof row.face.url === "string" ? row.face.url : undefined
        if (!url) return text(`error: 编号 ${id} 的收藏表情缺少可用地址`)
        guardOutbound(target, url)
        // 收藏表情的地址同样来自外部，要走和图片一致的路径与地址白名单。
        const plan = await outbound.check(url)
        const verdict = await permit(target, nextOperation())
        if (!verdict.allowed) return refuse(context.sessionID, verdict)
        const response = await send(target, [
          {
            type: "image",
            data: { file: outbound.materialize(plan), sub_type: CUSTOM_FACE_SUB_TYPE },
          },
        ])
        trackSent(target, response)
        manager.markMessageSent(context.sessionID)
        return text(`你已成功发送收藏表情 ${id}「${row.tag || "未标注"}」，可以选择结束对话`)
      },
    })

    editor.add({
      name: "send_record",
      description:
        "向当前 QQ 群聊或私聊发送一条语音。file 可以是本地路径或 http(s) 音频地址。本地路径只能取自机器人工作目录、媒体目录和配置放开的目录；http(s) 地址只允许公网地址。",
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
        if (!input.file) return text("error: 缺少 file")
        const tooLarge = checkInlineSize(input.file, "语音")
        if (tooLarge) return text(tooLarge)
        if (!isInlineData(input.file)) guardOutbound(target, input.file)
        const plan = isInlineData(input.file) ? undefined : await outbound.check(input.file)
        const verdict = await permit(target, nextOperation())
        if (!verdict.allowed) return refuse(context.sessionID, verdict)
        const media = plan ? outbound.materialize(plan) : input.file
        const response = await send(target, [{ type: "record", data: { file: media } }])
        trackSent(target, response)
        manager.markMessageSent(context.sessionID)
        return text("你已成功发送语音，可以选择结束对话")
      },
    })

    editor.add({
      name: "send_forward",
      description:
        "向当前 QQ 群聊或私聊发送一条合并转发消息。nodes 为节点列表，每个节点包含 user_id、nickname 和纯文本 content。",
      input: {
        type: "object",
        properties: {
          nodes: {
            type: "array",
            description: "合并转发的节点列表",
            items: {
              type: "object",
              properties: {
                user_id: { type: "string", description: "发送者 QQ 号" },
                nickname: { type: "string", description: "发送者昵称" },
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
        const nodes: {
          user_id: number
          nickname: string
          content: { type: string; data: { text: string } }[]
        }[] = []
        for (const node of input.nodes ?? []) {
          const userId = node.user_id === undefined ? 0 : Number(node.user_id)
          if (!Number.isInteger(userId) || userId < 0) {
            return text(`error: 非法 user_id：${String(node.user_id)}`)
          }
          const body = toPlainText(node.content ?? "").trim()
          const nickname = node.nickname?.trim() || "未知用户"
          // 昵称同样发给对方，不能成为凭证外发的盲区。
          guardOutbound(target, `${nickname}\n${body}`)
          nodes.push({
            user_id: userId,
            nickname,
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
      execute: async () => {
        const info = await client.api.getLoginInfo()
        return text(JSON.stringify(info))
      },
    })
  })
}
