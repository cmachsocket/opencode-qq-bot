import type { Plugin } from "@opencode/plugin"
import { type ChatTarget, isTargetEnabled, targetLabel } from "../chat"
import type { QQBotConfig } from "../config"
import {
  CUSTOM_FACE_SUB_TYPE,
  type FavoriteStore,
  formatFavoriteIds,
  formatFavoriteList,
} from "../emoji/favorites"
import type { FavoriteIndex } from "../emoji/favorite-index"
import type { Logger } from "../logger"
import type { QQClient } from "../naplink/client"
import { splitGraphemes, splitMessage, toPlainText } from "../outbound"
import type { SessionManager } from "../session/manager"

/** 工具命名空间，最终工具名为 qq_send_message 等。 */
export const TOOL_NAMESPACE = "qq"

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

/** QQ 单条消息的保守长度上限，超过时按段发送。 */
export { MAX_MESSAGE_CHARS } from "../outbound"

function text(value: string) {
  return { content: value }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 从 OneBot 发送结果里取出 message_id。 */
function messageIdOf(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined
  const record = response as { message_id?: unknown; data?: { message_id?: unknown } }
  const value = record.message_id ?? record.data?.message_id
  return value === undefined || value === null ? undefined : String(value)
}

/**
 * 向一个目标发送纯文本消息，超长时按段落拆分。
 *
 * 命令、后台任务这类没有会话轮次的场景用它回消息，
 * 内容由插件自己生成，不做 markdown 剥离。
 */
export async function sendPlainMessage(
  client: QQClient,
  target: ChatTarget,
  content: string,
  options: { delayMs?: number } = {},
): Promise<number> {
  const chunks = splitMessage(content)
  let sent = 0
  for (const [index, chunk] of chunks.entries()) {
    if (target.kind === "group") {
      await client.api.sendGroupMessage(target.id, chunk)
    } else {
      await client.api.sendPrivateMessage(target.id, chunk)
    }
    sent += 1
    if (index < chunks.length - 1 && (options.delayMs ?? 0) > 0) {
      await delay(options.delayMs ?? 0)
    }
  }
  return sent
}

/**
 * 注册 QQ 命名空间下的工具。
 *
 * 全部工具都是对 NapCat OneBot API 的透传，
 * 只暴露消息收发与只读查询，不提供封禁/踢人等破坏性操作。
 */
export async function registerTools(deps: ToolDeps): Promise<{ dispose(): Promise<void> }> {
  const { ctx, config, logger, manager, client, favorites, favoriteIndex } = deps

  const requireTarget = (sessionID: string): ChatTarget | undefined => {
    const target = manager.targetForSession(sessionID)
    if (!target) return undefined
    if (!isTargetEnabled(config, target)) {
      logger.warn(`${targetLabel(target)} 已不在配置中，拒绝工具调用`)
      return undefined
    }
    if (!manager.hasActiveTurn(sessionID)) {
      logger.warn(`会话 ${sessionID} 当前没有 QQ 消息轮次，拒绝工具调用`)
      return undefined
    }
    return target
  }

  const sendText = (target: ChatTarget, chunk: string) =>
    target.kind === "group"
      ? client.api.sendGroupMessage(target.id, chunk)
      : client.api.sendPrivateMessage(target.id, chunk)

  const sendSegments = (target: ChatTarget, segments: unknown[]) =>
    target.kind === "group"
      ? client.api.sendGroupMessage(target.id, segments)
      : client.api.sendPrivateMessage(target.id, segments)

  const sendForward = (target: ChatTarget, nodes: unknown[]) =>
    target.kind === "group"
      ? client.api.sendGroupForwardMessage(target.id, nodes)
      : client.api.sendPrivateForwardMessage({ user_id: target.id, messages: nodes })

  const sendPoke = (target: ChatTarget, userId: string | number) =>
    target.kind === "group"
      ? client.api.sendGroupPoke(target.id, userId)
      : client.api.sendFriendPoke(userId)

  return await ctx.tool.transform((editor) => {
    editor.namespace({
      name: TOOL_NAMESPACE,
      description:
        "QQ 聊天工具：发送消息、图片、语音、合并转发，以及查询用户信息。仅在 QQ 群聊或私聊会话里可用，其他会话调用会返回错误。",
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
      options: { namespace: TOOL_NAMESPACE },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as SendMessageInput
        const target = requireTarget(context.sessionID)
        if (!target) return text("error: 当前会话没有绑定 QQ 群聊或私聊")
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

        // 长度按字素簇算，和拆段的口径一致：一个 emoji 只算一个。
        const length = splitGraphemes(plain).length
        if (length > config.warnLength && input.unlimit_length !== true) {
          logger.warn(`send_message 内容长度 ${length} 超过 ${config.warnLength}`)
        }

        const chunks = splitMessage(plain)
        let sent = 0
        try {
          for (const [index, chunk] of chunks.entries()) {
            const response = await sendText(target, chunk)
            const messageId = messageIdOf(response)
            if (messageId) manager.rememberOutgoing(target, messageId)
            sent += 1
            if (index < chunks.length - 1 && config.sendDelayMs > 0) {
              await delay(config.sendDelayMs)
            }
          }
        } catch (error) {
          if (sent > 0) manager.markMessageSent(context.sessionID)
          logger.error(`${label} 发送消息失败，已发送 ${sent}/${chunks.length} 段`, error)
          return text(`error: 消息只发送了 ${sent}/${chunks.length} 段`)
        }
        manager.markMessageSent(context.sessionID)
        logger.info(`${label} 已发送 ${length} 字`)
        return text("你已成功发送消息，可以选择结束对话")
      },
    })

    editor.add({
      name: "send_image",
      description:
        "向当前 QQ 群聊或私聊发送一张图片。file 可以是本地路径或 http(s) 图片地址；base64 传 base64:// 形式的数据。",
      input: {
        type: "object",
        properties: {
          file: { type: "string", description: "本地文件路径或图片 URL" },
          base64: { type: "string", description: "base64 编码的图片数据" },
        },
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as MediaInput
        const target = requireTarget(context.sessionID)
        if (!target) return text("error: 当前会话没有绑定 QQ 群聊或私聊")
        const file = input.file ?? (input.base64 ? `base64://${input.base64}` : undefined)
        if (!file) return text("error: 缺少 file 或 base64")
        const response = await sendSegments(target, [{ type: "image", data: { file } }])
        const messageId = messageIdOf(response)
        if (messageId) manager.rememberOutgoing(target, messageId)
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
      options: { namespace: TOOL_NAMESPACE },
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
      options: { namespace: TOOL_NAMESPACE },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as StickerInput
        const target = requireTarget(context.sessionID)
        if (!target) return text("error: 当前会话没有绑定 QQ 群聊或私聊")
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
        const response = await sendSegments(target, [
          { type: "image", data: { file: url, sub_type: CUSTOM_FACE_SUB_TYPE } },
        ])
        const messageId = messageIdOf(response)
        if (messageId) manager.rememberOutgoing(target, messageId)
        manager.markMessageSent(context.sessionID)
        return text(`你已成功发送收藏表情 ${id}「${row.tag || "未标注"}」，可以选择结束对话`)
      },
    })

    editor.add({
      name: "send_record",
      description: "向当前 QQ 群聊或私聊发送一条语音。file 可以是本地路径或 http(s) 音频地址。",
      input: {
        type: "object",
        properties: {
          file: { type: "string", description: "本地文件路径或音频 URL" },
        },
        additionalProperties: false,
      },
      options: { namespace: TOOL_NAMESPACE },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as MediaInput
        const target = requireTarget(context.sessionID)
        if (!target) return text("error: 当前会话没有绑定 QQ 群聊或私聊")
        if (!input.file) return text("error: 缺少 file")
        const response = await sendSegments(target, [
          { type: "record", data: { file: input.file } },
        ])
        const messageId = messageIdOf(response)
        if (messageId) manager.rememberOutgoing(target, messageId)
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
      options: { namespace: TOOL_NAMESPACE },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as ForwardInput
        const target = requireTarget(context.sessionID)
        if (!target) return text("error: 当前会话没有绑定 QQ 群聊或私聊")
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
          nodes.push({
            user_id: userId,
            nickname: node.nickname?.trim() || "未知用户",
            content: [{ type: "text", data: { text: toPlainText(node.content ?? "").trim() } }],
          })
        }
        if (nodes.length === 0) return text("error: nodes 为空")
        const response = await sendForward(target, nodes)
        const messageId = messageIdOf(response)
        if (messageId) manager.rememberOutgoing(target, messageId)
        manager.markMessageSent(context.sessionID)
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
      options: { namespace: TOOL_NAMESPACE },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as UserInput
        const target = requireTarget(context.sessionID)
        if (!target) return text("error: 当前会话没有绑定 QQ 群聊或私聊")
        if (!input.user_id) return text("error: 缺少 user_id")
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
      options: { namespace: TOOL_NAMESPACE },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as MessageIdInput
        const target = requireTarget(context.sessionID)
        if (!target) return text("error: 当前会话没有绑定 QQ 群聊或私聊")
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
      options: { namespace: TOOL_NAMESPACE },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as UserInput
        const target = requireTarget(context.sessionID)
        if (!target) return text("error: 当前会话没有绑定 QQ 群聊或私聊")
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
      options: { namespace: TOOL_NAMESPACE },
      execute: async (raw, context) => {
        const input = (raw ?? {}) as MessageIdInput
        const target = requireTarget(context.sessionID)
        if (!target) return text("error: 当前会话没有绑定 QQ 群聊或私聊")
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
      options: { namespace: TOOL_NAMESPACE },
      execute: async () => {
        const info = await client.api.getLoginInfo()
        return text(JSON.stringify(info))
      },
    })
  })
}
