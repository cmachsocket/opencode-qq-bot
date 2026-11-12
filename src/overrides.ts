import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { type ChatTarget, targetKey } from "./chat"
import { DEFAULT_CONFIG, parseModelRef, type ModelRef, type WakeConfig } from "./config"
import type { Logger } from "./logger"

/** 唤醒方式：决定群里的消息要不要让模型必须回复。 */
export type WakeMode = "all" | "mention" | "prefix" | "none"

/** 全部合法的唤醒方式。 */
export const WAKE_MODES: readonly WakeMode[] = ["all", "mention", "prefix", "none"]

/** 触发必回的原因，给模型一句准确的话。 */
export type WakeReason = "private" | "all" | "mention" | "prefix" | "at_all" | "reply"

/** 一次唤醒判定需要的消息特征。 */
export interface WakeContext {
  /** 消息里 @ 了机器人。 */
  mentioned: boolean
  /** 消息里 @ 了全体成员。 */
  atAll: boolean
  /** 消息里第一个 @ 指向的是别人。 */
  atOthersFirst: boolean
  /** 这条消息回复的是机器人自己。 */
  replyToSelf: boolean
  /** 消息正文。 */
  text: string
}

/** 全局唤醒策略：与配置项 `wake` 同构。 */
export type WakePolicy = WakeConfig

/** 内置的全局唤醒策略，取自配置默认值。 */
export const DEFAULT_WAKE_POLICY: WakePolicy = {
  ...DEFAULT_CONFIG.wake,
  prefixes: [...DEFAULT_CONFIG.wake.prefixes],
}

/** 唤醒判定的结果。 */
export interface WakeDecision {
  /** 本轮是否必须回复。 */
  required: boolean
  /** 触发必回的原因。 */
  reason?: WakeReason
  /** 这条消息明确不是在跟机器人说话，别插话。 */
  suppress?: boolean
}

/** 主动说话的白名单。 */
export interface ProactiveScope {
  /** 只在这些群里主动说话；为空表示一个都不放行。 */
  allowGroups: number[]
  /** 只在这些私聊里主动说话；为空表示一个都不放行。 */
  allowUsers: number[]
}

/**
 * 单个聊天的行为覆盖。
 *
 * 键名与全局配置项一致：会话能改哪一项，就用那一项在 `config.json` 里的名字。
 */
export interface ChatOverride {
  /** 唤醒方式，缺省按被 @ 才必回；全局没有对应项，只在会话层出现。 */
  wake?: WakeMode
  /** 唤醒前缀，`wake` 为 `prefix` 时用；与全局 `wake.prefixes` 同名同形。 */
  "wake.prefixes"?: string[]
  /** 是否允许主动说话，对应全局 `proactive.enabled`。 */
  "proactive.enabled"?: boolean
  /** 这个聊天单次心跳的触发概率，对应全局 `proactive.startProbability`。 */
  "proactive.startProbability"?: number
  /** 覆盖该聊天使用的 OpenCode agent。 */
  agent?: string
  /** 覆盖该聊天使用的模型，格式 `provider/model[/variant]`。 */
  model?: ModelRef
  /** 覆盖该聊天使用的角色设定文件或目录，对应全局 `soulPath`。 */
  soulPath?: string
  /** 覆盖该聊天使用的角色设定文件名，对应全局 `soulName`。 */
  soulName?: string
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

/** 默认的配置文件位置：工作目录下的 `chat-overrides.json`。 */
export function defaultChatOverridesPath(home: string): string {
  return join(home, "chat-overrides.json")
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
    if (record["wake.prefixes"] !== undefined) {
      const raw = record["wake.prefixes"]
      if (!Array.isArray(raw)) {
        warn(`会话覆盖 ${key} 的 wake.prefixes 必须是字符串数组，已忽略`)
      } else {
        const prefixes = raw
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
        if (prefixes.length > 0) override["wake.prefixes"] = prefixes
        else warn(`会话覆盖 ${key} 的 wake.prefixes 至少要有一个非空前缀，已忽略`)
      }
    }
    if (record["proactive.enabled"] !== undefined) {
      if (typeof record["proactive.enabled"] === "boolean") {
        override["proactive.enabled"] = record["proactive.enabled"]
      } else {
        warn(`会话覆盖 ${key} 的 proactive.enabled 必须是布尔值，已忽略`)
      }
    }
    if (record["proactive.startProbability"] !== undefined) {
      const raw = record["proactive.startProbability"]
      const value =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && raw.trim()
            ? Number(raw.trim())
            : Number.NaN
      if (Number.isFinite(value) && value >= 0 && value <= 1) {
        override["proactive.startProbability"] = value
      } else {
        warn(`会话覆盖 ${key} 的 proactive.startProbability 必须是 0 到 1 之间的数字，已忽略`)
      }
    }
    if (record.agent !== undefined) {
      if (typeof record.agent === "string" && record.agent.trim()) {
        override.agent = record.agent.trim()
      } else {
        warn(`会话覆盖 ${key} 的 agent 必须是非空字符串，已忽略`)
      }
    }
    if (record.model !== undefined) {
      const model = parseModelRef(record.model)
      if (model) override.model = model
      else warn(`会话覆盖 ${key} 的 model 必须是 provider/model[/variant]，已忽略`)
    }
    if (record.soulPath !== undefined) {
      if (typeof record.soulPath === "string" && record.soulPath.trim()) {
        override.soulPath = record.soulPath.trim()
      } else {
        warn(`会话覆盖 ${key} 的 soulPath 必须是非空字符串，已忽略`)
      }
    }
    if (record.soulName !== undefined) {
      if (typeof record.soulName === "string" && record.soulName.trim()) {
        override.soulName = record.soulName.trim()
      } else {
        warn(`会话覆盖 ${key} 的 soulName 必须是非空字符串，已忽略`)
      }
    }
    if (override.wake === "prefix" && !override["wake.prefixes"]?.length) {
      // 没有前缀就没法判断，改回被 @ 才必回，别让群变成完全不回话。
      warn(`会话覆盖 ${key} 使用 prefix 唤醒但没有写 wake.prefixes，已按被 @ 才必回处理`)
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

/**
 * 这次要不要让模型必须回复，以及为什么。
 *
 * 判定顺序：私聊必回；聊天自己写死的唤醒方式优先；被直接 @ 一定回；
 * 群里第一个 @ 指向别人时这条消息不是跟机器人说的；
 * 其余看全局前缀、@全体成员与回复机器人自己。
 */
export function wakeDecision(
  override: ChatOverride,
  target: ChatTarget,
  context: WakeContext,
  policy: WakePolicy = DEFAULT_WAKE_POLICY,
): WakeDecision {
  // 私聊都是冲着机器人来的，永远必回。
  if (target.kind === "private") return { required: true, reason: "private" }
  // 静音的群完全不理。
  if (override.wake === "none") return { required: false }
  // 逐条回复的群每条都要回：写死的配置优先于其它规则。
  if (override.wake === "all") return { required: true, reason: "all" }
  // 被直接 @ 时一定回，不管这个聊天配了什么。
  if (context.mentioned) return { required: true, reason: "mention" }
  // 群里第一个 @ 的是别人：这条消息不是跟机器人说的，别插话。
  if (policy.ignoreAtOthers && context.atOthersFirst) return { required: false, suppress: true }
  // 前缀模式只看这个聊天自己的前缀。
  if (override.wake === "prefix") {
    const text = context.text.trimStart()
    const prefixes = override["wake.prefixes"] ?? []
    return prefixes.some((prefix) => prefix && text.startsWith(prefix))
      ? { required: true, reason: "prefix" }
      : { required: false }
  }
  // 全局前缀。
  for (const prefix of policy.prefixes) {
    if (prefix && context.text.trimStart().startsWith(prefix)) {
      return { required: true, reason: "prefix" }
    }
  }
  // @全体成员：默认忽略，群里点名全体成员多半不是在跟机器人说话。
  if (context.atAll && !policy.ignoreAtAll) return { required: true, reason: "at_all" }
  // 回复了机器人自己：顺着回。
  if (context.replyToSelf && policy.replyToSelf) return { required: true, reason: "reply" }
  return { required: false }
}

/**
 * 这个聊天允不允许主动说话。
 *
 * 默认拒绝：白名单为空表示一个都不放行，必须显式配置才会主动开口。
 * 聊天自己的覆盖里写了 `proactive.enabled: true` 才算显式打开，那一条不受白名单限制。
 */
export function proactiveAllowed(
  override: ChatOverride,
  target: ChatTarget,
  scope: ProactiveScope,
): boolean {
  if (override["proactive.enabled"] === false) return false
  if (chatMuted(override, target)) return false
  // 写死打开的聊天不受白名单限制。
  if (override["proactive.enabled"] === true) return true
  const list = target.kind === "group" ? scope.allowGroups : scope.allowUsers
  // 名单为空表示这一类一个都不放行。
  if (list.length === 0) return false
  return list.includes(target.id)
}

/** 覆盖配置的简明描述，给 `/status` 看。 */
export function describeOverride(override: ChatOverride): string {
  const parts: string[] = []
  parts.push(override.wake ? `唤醒 ${override.wake}` : "唤醒 mention（默认）")
  if (override.wake === "prefix") {
    const prefixes = override["wake.prefixes"]?.join(" / ")
    parts.push(`前缀 ${prefixes ?? "（未设置）"}`)
  }
  parts.push(
    override["proactive.enabled"] === true
      ? "主动说话"
      : override["proactive.enabled"] === false
        ? "不主动说话"
        : "主动说话跟随白名单",
  )
  if (override["proactive.startProbability"] !== undefined) {
    parts.push(`主动概率 ${override["proactive.startProbability"]}`)
  }
  if (override.agent) parts.push(`agent ${override.agent}`)
  if (override.model) parts.push(`模型 ${override.model.providerID}/${override.model.id}`)
  if (override.soulPath) parts.push(`角色设定 ${override.soulPath}`)
  else if (override.soulName) parts.push(`角色设定 ${override.soulName}`)
  return parts.join("，")
}
