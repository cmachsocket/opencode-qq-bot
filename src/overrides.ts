import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { type ChatTarget, targetKey } from "./chat"
import type { Logger } from "./logger"

/** 唤醒方式：决定群里的消息要不要让模型必须回复。 */
export type WakeMode = "all" | "mention" | "prefix" | "none"

/** 全部合法的唤醒方式。 */
export const WAKE_MODES: readonly WakeMode[] = ["all", "mention", "prefix", "none"]

/** 触发必回的原因，给模型一句准确的话。 */
export type WakeReason = "private" | "all" | "mention" | "prefix"

/** 单个聊天的行为覆盖。 */
export interface ChatOverride {
  /** 唤醒方式，缺省按被 @ 才必回。 */
  wake?: WakeMode
  /** 唤醒前缀，`wake` 为 `prefix` 时用。 */
  prefix?: string
  /** 是否允许主动说话，false 表示这个聊天不主动开口。 */
  proactive?: boolean
}

/** `chat-overrides.json` 的结构。 */
export interface ChatOverridesFile {
  /** 按聊天指定的行为覆盖：`group:100` / `private:200`。 */
  chats: Record<string, ChatOverride>
}

/** 内置默认值：没有任何覆盖，全部按默认行为走。 */
export function defaultChatOverrides(): ChatOverridesFile {
  return { chats: {} }
}

/** 默认的配置文件位置：当前工作目录下的 `chat-overrides.json`。 */
export function defaultChatOverridesPath(): string {
  return join(process.cwd(), "chat-overrides.json")
}

/**
 * 解析并校验覆盖配置。
 *
 * 写错的字段只忽略这一项并告警，其余照常生效：一处笔误不该让整个文件失效。
 */
export function parseChatOverrides(
  value: unknown,
  warn: (message: string) => void,
): ChatOverridesFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warn("会话覆盖必须是对象，已忽略")
    return defaultChatOverrides()
  }
  const raw = value as Record<string, unknown>
  const source = raw.chats
  if (source === undefined) return defaultChatOverrides()
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    warn("chats 必须是对象，已忽略")
    return defaultChatOverrides()
  }
  const chats: Record<string, ChatOverride> = {}
  for (const [key, entry] of Object.entries(source as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      warn(`会话覆盖 ${key} 必须是对象，已忽略`)
      continue
    }
    const record = entry as Record<string, unknown>
    const override: ChatOverride = {}
    if (record.wake !== undefined) {
      if (typeof record.wake === "string" && WAKE_MODES.includes(record.wake as WakeMode)) {
        override.wake = record.wake as WakeMode
      } else {
        warn(`会话覆盖 ${key} 的 wake 只能是 ${WAKE_MODES.join(" / ")}，已忽略`)
      }
    }
    if (record.prefix !== undefined) {
      if (typeof record.prefix === "string") {
        const prefix = record.prefix.trim()
        if (prefix) override.prefix = prefix
      } else {
        warn(`会话覆盖 ${key} 的 prefix 必须是字符串，已忽略`)
      }
    }
    if (record.proactive !== undefined) {
      if (typeof record.proactive === "boolean") {
        override.proactive = record.proactive
      } else {
        warn(`会话覆盖 ${key} 的 proactive 必须是布尔值，已忽略`)
      }
    }
    if (override.wake === "prefix" && !override.prefix) {
      // 没有前缀就没法判断，改回被 @ 才必回，别让群变成完全不回话。
      warn(`会话覆盖 ${key} 使用 prefix 唤醒但没有写 prefix，已按被 @ 才必回处理`)
      delete override.wake
    }
    chats[key] = override
  }
  return { chats }
}

/** 会话覆盖的读取与热加载。 */
export class ChatOverrides {
  private cached?: { mtime: number; file: ChatOverridesFile }

  constructor(
    private readonly path: string,
    private readonly logger: Logger,
  ) {}

  /** 当前生效的覆盖配置；文件改动后按 mtime 重新读取。 */
  async current(): Promise<ChatOverridesFile> {
    const info = await stat(this.path).catch(() => undefined)
    if (!info) {
      if (!this.cached) this.cached = { mtime: 0, file: defaultChatOverrides() }
      return this.cached.file
    }
    if (this.cached && this.cached.mtime === info.mtimeMs) return this.cached.file
    try {
      const text = await readFile(this.path, "utf8")
      const file = parseChatOverrides(JSON.parse(text), (message) => {
        this.logger.warn(`会话覆盖 ${this.path}：${message}`)
      })
      this.cached = { mtime: info.mtimeMs, file }
      return file
    } catch (error) {
      // 半写或语法错误时保留上一份可用配置，等下一次写入后再加载。
      this.logger.warn(`会话覆盖 ${this.path} 读取失败，继续沿用上一份配置`, error)
      if (!this.cached) this.cached = { mtime: 0, file: defaultChatOverrides() }
      return this.cached.file
    }
  }

  /** 某个聊天生效的覆盖配置。 */
  async for(target: ChatTarget): Promise<ChatOverride> {
    const file = await this.current()
    return file.chats[targetKey(target)] ?? {}
  }
}

/** 这个聊天是不是完全不响应了：群里把 wake 设成 none 就是。 */
export function chatMuted(override: ChatOverride, target: ChatTarget): boolean {
  return target.kind === "group" && override.wake === "none"
}

/** 这次要不要让模型必须回复，以及为什么。 */
export function wakeDecision(
  override: ChatOverride,
  target: ChatTarget,
  mentioned: boolean,
  text: string,
): { required: boolean; reason?: WakeReason } {
  // 私聊都是冲着机器人来的，永远必回。
  if (target.kind === "private") return { required: true, reason: "private" }
  switch (override.wake) {
    case "all":
      return { required: true, reason: "all" }
    case "none":
      return { required: false }
    case "prefix": {
      if (mentioned) return { required: true, reason: "mention" }
      const prefix = override.prefix
      return prefix && text.trimStart().startsWith(prefix)
        ? { required: true, reason: "prefix" }
        : { required: false }
    }
    default:
      return mentioned ? { required: true, reason: "mention" } : { required: false }
  }
}

/** 这个聊天允不允许主动说话。 */
export function proactiveAllowed(override: ChatOverride, target: ChatTarget): boolean {
  if (override.proactive === false) return false
  if (chatMuted(override, target)) return false
  return true
}

/** 覆盖配置的简明描述，给 `/status` 看。 */
export function describeOverride(override: ChatOverride): string {
  const parts: string[] = []
  parts.push(override.wake ? `唤醒 ${override.wake}` : "唤醒 mention（默认）")
  if (override.wake === "prefix") parts.push(`前缀 ${override.prefix ?? "（未设置）"}`)
  parts.push(override.proactive === false ? "不主动说话" : "允许主动说话")
  return parts.join("，")
}
