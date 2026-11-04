import type { Plugin } from "@opencode/plugin"
import type { QQBotConfig } from "../config"
import type { Logger } from "../logger"
import type { QQClient } from "../naplink/client"
import type { SessionManager } from "../session/manager"

/** 工具命名空间，最终工具名为 qq_send_message 等。 */
export const TOOL_NAMESPACE = "qq"

export interface ToolDeps {
  ctx: Plugin.Context
  config: QQBotConfig
  logger: Logger
  manager: SessionManager
  client: QQClient
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

interface MessageIdInput {
  message_id?: number | string
}

/** QQ 单条消息的保守长度上限，超过时按段发送。 */
export const MAX_MESSAGE_CHARS = 4000

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

/** 按长度切分消息，保留原有换行与空行。 */
export function splitMessage(content: string, max = MAX_MESSAGE_CHARS): string[] {
  if (Array.from(content).length <= max) return [content]
  const chunks: string[] = []
  let current = ""
  for (const line of content.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line
    if (Array.from(candidate).length <= max) {
      current = candidate
      continue
    }
    if (current) chunks.push(current)
    let rest = line
    while (Array.from(rest).length > max) {
      const part = Array.from(rest).slice(0, max).join("")
      chunks.push(part)
      rest = Array.from(rest).slice(max).join("")
    }
    current = rest
  }
  if (current) chunks.push(current)
  return chunks.length > 0 ? chunks : [content]
}

/**
 * 注册 QQ 命名空间下的工具。
 *
 * 全部工具都是对 NapCat OneBot API 的透传，
 * 只暴露消息收发与只读查询，不提供封禁/踢人等破坏性操作。
 */
export async function registerTools(deps: ToolDeps): Promise<{ dispose(): Promise<void> }> {
  const { ctx, config, logger, manager, client } = deps

  const requireGroup = (sessionID: string): string | undefined => {
    const groupId = manager.groupForSession(sessionID)
    if (groupId === undefined) return undefined
    if (!config.groups.includes(groupId)) {
      logger.warn(`群 ${groupId} 已不在配置中，拒绝工具调用`)
      return undefined
    }
    if (!manager.hasActiveTurn(sessionID)) {
      logger.warn(`会话 ${sessionID} 当前没有 QQ 消息轮次，拒绝工具调用`)
      return undefined
    }
    return String(groupId)
  }

  return await ctx.tool.transform((editor) => {
    editor.namespace({
      name: TOOL_NAMESPACE,
      description:
        "QQ 群聊工具：发送消息、图片、语音、合并转发，以及查询群成员信息。仅在 QQ 群会话里可用，其他会话调用会返回错误。",
    })

    editor.add({
      name: "send_message",
      description:
        "向当前群聊发送一条消息。每轮必须调用一个发送工具。content: 要发送的文本；reply: true 表示发送，false 表示选择不发送（已读不回）；unlimit_length: 设为 true 可解除默认的长度告警限制。",
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
        const groupId = requireGroup(context.sessionID)
        if (!groupId) return text("error: 当前会话没有绑定 QQ 群")

        if (input.reply === false) {
          logger.info(`群 ${groupId} 模型选择不回复`)
          manager.markMessageSent(context.sessionID)
          return text("skipped")
        }
        const content = (input.content ?? "").trim()
        if (!content) {
          logger.info(`群 ${groupId} 回复内容为空`)
          manager.markMessageSent(context.sessionID)
          return text("skipped")
        }

        if (content.length > config.warnLength && input.unlimit_length !== true) {
          logger.warn(`send_message 内容长度 ${content.length} 超过 ${config.warnLength}`)
        }

        const chunks = splitMessage(content)
        let sent = 0
        try {
          for (const [index, chunk] of chunks.entries()) {
            const response = await client.api.sendGroupMessage(groupId, chunk)
            const messageId = messageIdOf(response)
            if (messageId) manager.rememberOutgoing(groupId, messageId)
            sent += 1
            if (index < chunks.length - 1 && config.sendDelayMs > 0) {
              await delay(config.sendDelayMs)
            }
          }
        } catch (error) {
          if (sent > 0) manager.markMessageSent(context.sessionID)
          logger.error(`群 ${groupId} 发送消息失败，已发送 ${sent}/${chunks.length} 段`, error)
          return text(`error: 消息只发送了 ${sent}/${chunks.length} 段`)
        }
        manager.markMessageSent(context.sessionID)
        logger.info(`群 ${groupId} 已发送 ${content.length} 字`)
        return text("sent")
      },
    })

    editor.add({
      name: "send_image",
      description:
        "向当前群聊发送一张图片。file 可以是本地路径或 http(s) 图片地址；base64 传 base64:// 形式的数据。",
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
        const groupId = requireGroup(context.sessionID)
        if (!groupId) return text("error: 当前会话没有绑定 QQ 群")
        const file = input.file ?? (input.base64 ? `base64://${input.base64}` : undefined)
        if (!file) return text("error: 缺少 file 或 base64")
        const response = await client.api.sendGroupMessage(groupId, [
          { type: "image", data: { file } },
        ])
        const messageId = messageIdOf(response)
        if (messageId) manager.rememberOutgoing(groupId, messageId)
        manager.markMessageSent(context.sessionID)
        return text("sent")
      },
    })

    editor.add({
      name: "send_record",
      description: "向当前群聊发送一条语音。file 可以是本地路径或 http(s) 音频地址。",
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
        const groupId = requireGroup(context.sessionID)
        if (!groupId) return text("error: 当前会话没有绑定 QQ 群")
        if (!input.file) return text("error: 缺少 file")
        const response = await client.api.sendGroupMessage(groupId, [
          { type: "record", data: { file: input.file } },
        ])
        const messageId = messageIdOf(response)
        if (messageId) manager.rememberOutgoing(groupId, messageId)
        manager.markMessageSent(context.sessionID)
        return text("sent")
      },
    })

    editor.add({
      name: "send_forward",
      description:
        "向当前群聊发送一条合并转发消息。nodes 为节点列表，每个节点包含 user_id、nickname 和纯文本 content。",
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
        const groupId = requireGroup(context.sessionID)
        if (!groupId) return text("error: 当前会话没有绑定 QQ 群")
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
            content: [{ type: "text", data: { text: node.content ?? "" } }],
          })
        }
        if (nodes.length === 0) return text("error: nodes 为空")
        const response = await client.api.sendGroupForwardMessage(groupId, nodes)
        const messageId = messageIdOf(response)
        if (messageId) manager.rememberOutgoing(groupId, messageId)
        manager.markMessageSent(context.sessionID)
        return text("sent")
      },
    })

    editor.add({
      name: "send_poke",
      description: "在群里戳一下某个用户。",
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
        const groupId = requireGroup(context.sessionID)
        if (!groupId) return text("error: 当前会话没有绑定 QQ 群")
        if (!input.user_id) return text("error: 缺少 user_id")
        await client.api.sendGroupPoke(groupId, input.user_id)
        manager.markMessageSent(context.sessionID)
        return text("sent")
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
        const groupId = requireGroup(context.sessionID)
        if (!groupId) return text("error: 当前会话没有绑定 QQ 群")
        if (input.message_id === undefined) return text("error: 缺少 message_id")
        if (!manager.isOutgoing(groupId, String(input.message_id))) {
          return text("error: 只能撤回机器人自己发送过的消息")
        }
        await client.api.deleteMessage(input.message_id)
        return text("deleted")
      },
    })

    editor.add({
      name: "get_group_member_info",
      description: "查询某个群成员的群名片与 QQ 昵称。",
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
        const groupId = requireGroup(context.sessionID)
        if (!groupId) return text("error: 当前会话没有绑定 QQ 群")
        if (!input.user_id) return text("error: 缺少 user_id")
        const info = await client.api.getGroupMemberInfo(groupId, input.user_id)
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
        const groupId = requireGroup(context.sessionID)
        if (!groupId) return text("error: 当前会话没有绑定 QQ 群")
        if (input.message_id === undefined) return text("error: 缺少 message_id")
        if (!manager.isKnownMessage(groupId, String(input.message_id))) {
          return text("error: 只能转写当前群最近收到的消息")
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
