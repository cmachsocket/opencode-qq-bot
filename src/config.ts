/**
 * Plugin configuration: merges OpenCode plugin options, environment variables
 * and built-in defaults into a single validated object.
 *
 * Credentials are never stored in the repository: the NapCat endpoint and token
 * must be supplied through the environment or through plugin options.
 */

export interface NapcatConfig {
  /** NapCat 正向 WebSocket 地址，必填。 */
  url: string
  /** NapCat 访问令牌，可选。 */
  token?: string
}

export interface ProactiveConfig {
  /** 是否启用主动说话心跳。 */
  enabled: boolean
  /** 群沉默多少秒后才开始参与主动说话的概率计算。 */
  silenceThresholdSeconds: number
  /** 刚跨过阈值时的初始概率。 */
  startProbability: number
  /** 每多沉默一小时概率的增量。 */
  probabilityPerHour: number
  /** 心跳间隔（秒）。 */
  tickSeconds: number
}

export interface ReminderConfig {
  /** 模型一轮结束时没有调用 qq_send_message 时，是否提醒它补一次。 */
  enabled: boolean
  /** 连续提醒次数上限，避免死循环。 */
  max: number
}

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface QQBotConfig {
  napcat: NapcatConfig
  /** 参与 AI 对话的群号。 */
  groups: number[]
  /** 角色设定文件路径，默认使用插件包内的 SOUL.txt。 */
  soulPath?: string
  /** QQ 会话使用的 OpenCode agent。 */
  agent?: string
  /** QQ 会话使用的模型。 */
  model?: ModelRef
  /** 拆行发送时每条消息之间的间隔（毫秒）。 */
  sendDelayMs: number
  /** 单条消息超过该长度时告警（不截断）。 */
  warnLength: number
  /** 重启后是否复用上一次的会话。 */
  reuseSession: boolean
  /** 会话忙碌超过该时长（毫秒）视为卡死，强制放行缓存的消息。 */
  busyTimeoutMs: number
  proactive: ProactiveConfig
  reminder: ReminderConfig
}

/** 除 NapCat 连接信息外的全部默认值。 */
export const DEFAULT_CONFIG: Omit<QQBotConfig, "napcat"> = {
  groups: [],
  sendDelayMs: 1000,
  warnLength: 20,
  reuseSession: false,
  busyTimeoutMs: 300_000,
  proactive: {
    enabled: true,
    silenceThresholdSeconds: 3 * 3600,
    startProbability: 0.01,
    probabilityPerHour: 0.05,
    tickSeconds: 3600,
  },
  reminder: { enabled: true, max: 2 },
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function asGroupList(value: unknown): number[] | undefined {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : undefined
  if (!source) return undefined
  const groups: number[] = []
  for (const entry of source) {
    const raw = typeof entry === "number" ? String(entry) : asString(entry)?.trim()
    if (!raw) continue
    const parsed = Number(raw)
    if (Number.isInteger(parsed)) groups.push(parsed)
  }
  return groups
}

/** 解析 "provider/model" 或 "provider/model/variant"。 */
function parseModelRef(value: unknown): ModelRef | undefined {
  const raw = asString(value)?.trim()
  if (!raw) return undefined
  const parts = raw.split("/").filter(Boolean)
  const providerID = parts[0]
  const id = parts[1]
  if (!providerID || !id) return undefined
  const variant = parts[2]
  return variant ? { providerID, id, variant } : { providerID, id }
}

interface EnvConfig extends Omit<QQBotConfig, "napcat"> {
  napcat: { url?: string; token?: string }
}

function fromEnv(env: Record<string, string | undefined>): EnvConfig {
  const groups = asGroupList(env["QQ_TARGET_GROUPS"])
  const model = parseModelRef(env["QQ_BOT_MODEL"])
  const proactiveEnabled = asBoolean(env["QQ_PROACTIVE_ENABLED"])
  const reminderEnabled = asBoolean(env["QQ_REMINDER_ENABLED"])
  const reuseSession = asBoolean(env["QQ_REUSE_SESSION"])

  return {
    napcat: {
      url: asString(env["NAPCAT_WS_URL"]),
      token: asString(env["NAPCAT_WS_TOKEN"]),
    },
    groups: groups ?? [],
    soulPath: asString(env["QQ_BOT_SOUL_PATH"]),
    agent: asString(env["QQ_BOT_AGENT"]),
    model,
    sendDelayMs: asNumber(env["QQ_SEND_DELAY_MS"]) ?? DEFAULT_CONFIG.sendDelayMs,
    warnLength: asNumber(env["QQ_WARN_LENGTH"]) ?? DEFAULT_CONFIG.warnLength,
    reuseSession: reuseSession ?? DEFAULT_CONFIG.reuseSession,
    busyTimeoutMs: asNumber(env["QQ_BUSY_TIMEOUT_MS"]) ?? DEFAULT_CONFIG.busyTimeoutMs,
    proactive: {
      enabled: proactiveEnabled ?? DEFAULT_CONFIG.proactive.enabled,
      silenceThresholdSeconds:
        asNumber(env["QQ_PROACTIVE_SILENCE_SECONDS"]) ??
        DEFAULT_CONFIG.proactive.silenceThresholdSeconds,
      startProbability:
        asNumber(env["QQ_PROACTIVE_P_START"]) ?? DEFAULT_CONFIG.proactive.startProbability,
      probabilityPerHour:
        asNumber(env["QQ_PROACTIVE_P_SLOPE_PER_HOUR"]) ??
        DEFAULT_CONFIG.proactive.probabilityPerHour,
      tickSeconds:
        asNumber(env["QQ_PROACTIVE_TICK_SECONDS"]) ?? DEFAULT_CONFIG.proactive.tickSeconds,
    },
    reminder: {
      enabled: reminderEnabled ?? DEFAULT_CONFIG.reminder.enabled,
      max: asNumber(env["QQ_REMINDER_MAX"]) ?? DEFAULT_CONFIG.reminder.max,
    },
  }
}

/**
 * 合并插件选项与环境变量。插件选项优先级更高。
 *
 * @throws 当没有提供 NapCat WebSocket 地址时抛出，避免带着无效凭证启动。
 */
export function resolveConfig(
  options: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): QQBotConfig {
  const base = fromEnv(env)
  const napcat = (options["napcat"] ?? {}) as Record<string, unknown>
  const proactive = (options["proactive"] ?? {}) as Record<string, unknown>
  const reminder = (options["reminder"] ?? {}) as Record<string, unknown>

  const url = asString(napcat["url"]) ?? base.napcat.url
  if (!url) {
    throw new Error(
      "未配置 NapCat WebSocket 地址：请设置环境变量 NAPCAT_WS_URL 或插件选项 napcat.url",
    )
  }

  const groups = asGroupList(options["groups"]) ?? base.groups
  const soulPath = asString(options["soulPath"]) ?? base.soulPath
  const agent = asString(options["agent"]) ?? base.agent
  const model = parseModelRef(options["model"]) ?? base.model

  return {
    napcat: {
      url,
      token: asString(napcat["token"]) ?? base.napcat.token,
    },
    groups,
    soulPath,
    agent,
    model,
    sendDelayMs: asNumber(options["sendDelayMs"]) ?? base.sendDelayMs,
    warnLength: asNumber(options["warnLength"]) ?? base.warnLength,
    reuseSession: asBoolean(options["reuseSession"]) ?? base.reuseSession,
    busyTimeoutMs: asNumber(options["busyTimeoutMs"]) ?? base.busyTimeoutMs,
    proactive: {
      enabled: asBoolean(proactive["enabled"]) ?? base.proactive.enabled,
      silenceThresholdSeconds:
        asNumber(proactive["silenceThresholdSeconds"]) ?? base.proactive.silenceThresholdSeconds,
      startProbability: asNumber(proactive["startProbability"]) ?? base.proactive.startProbability,
      probabilityPerHour:
        asNumber(proactive["probabilityPerHour"]) ?? base.proactive.probabilityPerHour,
      tickSeconds: asNumber(proactive["tickSeconds"]) ?? base.proactive.tickSeconds,
    },
    reminder: {
      enabled: asBoolean(reminder["enabled"]) ?? base.reminder.enabled,
      max: asNumber(reminder["max"]) ?? base.reminder.max,
    },
  }
}
