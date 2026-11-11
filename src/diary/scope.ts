import { type ChatTarget, targetKey } from "../chat"
import type { QQBotConfig } from "../config"

/**
 * 日记的范围：只有 owner 与机器人的那条私聊。
 *
 * 维护者裁定（日记范围收窄到 owner 的会话）：
 * 采集、总结、工具、命令与推送都只认这一条会话，
 * 剩下的会话一旦只有一条，跨聊天串档的前提就不存在了。
 */
export function diaryScopeChat(config: QQBotConfig): ChatTarget | undefined {
  if (config.ownerQQ === undefined) return undefined
  return { kind: "private", id: config.ownerQQ }
}

/** 日记范围的会话键；没有配置 owner 时返回 undefined。 */
export function diaryScopeKey(config: QQBotConfig): string | undefined {
  const chat = diaryScopeChat(config)
  return chat ? targetKey(chat) : undefined
}

/** 某个聊天是否在日记范围内。 */
export function isDiaryScopeChat(config: QQBotConfig, target: ChatTarget): boolean {
  const scope = diaryScopeChat(config)
  if (!scope) return false
  return scope.kind === target.kind && scope.id === target.id
}
