import { Model } from "@opencode/schema"

/**
 * Plugin configuration: merges OpenCode plugin options, environment variables
 * and built-in defaults into a single validated object.
 *
 * Credentials are never stored in the repository: the NapCat endpoint and token
 * must be supplied through the environment or through plugin options.
 */

/** 环境变量里可用的真值写法。 */
const TRUTHY = new Set(["1", "true", "yes", "on"])
/** 环境变量里可用的假值写法。 */
const FALSY = new Set(["0", "false", "no", "off"])

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

/** 配置告警回调。 */
export type ConfigWarning = (message: string) => void

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** 解析数字：接受原生 number，也接受环境变量里的数字字符串。 */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string") {
    const raw = value.trim()
    if (!raw) return undefined
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 解析布尔值：接受原生 boolean，也接受环境变量里的 true/false/1/0/yes/no/on/off。 */
function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase()
    if (TRUTHY.has(raw)) return true
    if (FALSY.has(raw)) return false
  }
  return undefined
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

/**
 * 解析 "provider/model" 或 "provider/model/variant"，复用 SDK 的模型引用解析。
 *
 * 写法不合法时通过 `onInvalid` 上报，避免配置写错却静默失效。
 */
function parseModelRef(value: unknown, onInvalid?: (raw: string) => void): ModelRef | undefined {
  const raw = asString(value)?.trim()
  if (!raw) return undefined
  const [providerID, id, variant, ...rest] = raw.split("/").filter(Boolean)
  if (!providerID || !id || rest.length > 0) {
    onInvalid?.(raw)
    return undefined
  }
  try {
    const ref = Model.Ref.parse(`${providerID}/${id}${variant ? `#${variant}` : ""}`)
    return {
      providerID: ref.providerID,
      id: ref.id,
      ...(ref.variant ? { variant: ref.variant } : {}),
    }
  } catch {
    onInvalid?.(raw)
    return undefined
  }
}

/** 读取布尔配置：值非法时告警并回退到默认值。 */
function pickBoolean(label: string, raw: unknown, fallback: boolean, warnings: string[]): boolean {
  if (raw === undefined || raw === null || raw === "") return fallback
  const parsed = asBoolean(raw)
  if (parsed === undefined) {
    warnings.push(`${label} 不是合法的布尔值：${String(raw)}`)
    return fallback
  }
  return parsed
}

/** 读取数字配置：值非法时告警并回退到默认值。 */
function pickNumber(label: string, raw: unknown, fallback: number, warnings: string[]): number {
  if (raw === undefined || raw === null || raw === "") return fallback
  const parsed = asNumber(raw)
  if (parsed === undefined) {
    warnings.push(`${label} 不是合法的数字：${String(raw)}`)
    return fallback
  }
  return parsed
}

/** 读取正数配置：非正数会让心跳退化成热循环，告警并回退到默认值。 */
function pickPositive(label: string, raw: unknown, fallback: number, warnings: string[]): number {
  const value = pickNumber(label, raw, fallback, warnings)
  if (value <= 0) {
    warnings.push(`${label} 必须大于 0，当前为 ${value}，已回退到 ${fallback}`)
    return fallback
  }
  return value
}

interface EnvConfig extends Omit<QQBotConfig, "napcat"> {
  napcat: { url?: string; token?: string }
}

function fromEnv(env: Record<string, string | undefined>, warnings: string[]): EnvConfig {
  const groups = asGroupList(env["QQ_TARGET_GROUPS"])
  if (env["QQ_TARGET_GROUPS"] && groups?.length === 0) {
    warnings.push(`QQ_TARGET_GROUPS 解析不出群号：${env["QQ_TARGET_GROUPS"]}`)
  }
  const model = parseModelRef(env["QQ_BOT_MODEL"], (raw) =>
    warnings.push(`QQ_BOT_MODEL 格式无效：${raw}（应为 provider/model[/variant]）`),
  )

  return {
    napcat: {
      url: asString(env["NAPCAT_WS_URL"]),
      token: asString(env["NAPCAT_WS_TOKEN"]),
    },
    groups: groups ?? [],
    soulPath: asString(env["QQ_BOT_SOUL_PATH"]),
    agent: asString(env["QQ_BOT_AGENT"]),
    model,
    sendDelayMs: pickNumber(
      "QQ_SEND_DELAY_MS",
      env["QQ_SEND_DELAY_MS"],
      DEFAULT_CONFIG.sendDelayMs,
      warnings,
    ),
    warnLength: pickNumber(
      "QQ_WARN_LENGTH",
      env["QQ_WARN_LENGTH"],
      DEFAULT_CONFIG.warnLength,
      warnings,
    ),
    reuseSession: pickBoolean(
      "QQ_REUSE_SESSION",
      env["QQ_REUSE_SESSION"],
      DEFAULT_CONFIG.reuseSession,
      warnings,
    ),
    busyTimeoutMs: pickNumber(
      "QQ_BUSY_TIMEOUT_MS",
      env["QQ_BUSY_TIMEOUT_MS"],
      DEFAULT_CONFIG.busyTimeoutMs,
      warnings,
    ),
    proactive: {
      enabled: pickBoolean(
        "QQ_PROACTIVE_ENABLED",
        env["QQ_PROACTIVE_ENABLED"],
        DEFAULT_CONFIG.proactive.enabled,
        warnings,
      ),
      silenceThresholdSeconds: pickNumber(
        "QQ_PROACTIVE_SILENCE_SECONDS",
        env["QQ_PROACTIVE_SILENCE_SECONDS"],
        DEFAULT_CONFIG.proactive.silenceThresholdSeconds,
        warnings,
      ),
      startProbability: pickNumber(
        "QQ_PROACTIVE_P_START",
        env["QQ_PROACTIVE_P_START"],
        DEFAULT_CONFIG.proactive.startProbability,
        warnings,
      ),
      probabilityPerHour: pickNumber(
        "QQ_PROACTIVE_P_SLOPE_PER_HOUR",
        env["QQ_PROACTIVE_P_SLOPE_PER_HOUR"],
        DEFAULT_CONFIG.proactive.probabilityPerHour,
        warnings,
      ),
      tickSeconds: pickPositive(
        "QQ_PROACTIVE_TICK_SECONDS",
        env["QQ_PROACTIVE_TICK_SECONDS"],
        DEFAULT_CONFIG.proactive.tickSeconds,
        warnings,
      ),
    },
    reminder: {
      enabled: pickBoolean(
        "QQ_REMINDER_ENABLED",
        env["QQ_REMINDER_ENABLED"],
        DEFAULT_CONFIG.reminder.enabled,
        warnings,
      ),
      max: pickNumber(
        "QQ_REMINDER_MAX",
        env["QQ_REMINDER_MAX"],
        DEFAULT_CONFIG.reminder.max,
        warnings,
      ),
    },
  }
}

/**
 * 合并插件选项与环境变量。插件选项优先级更高。
 *
 * 写错的配置项不会静默失效，而是通过 `onWarning` 报告。
 *
 * @throws 当没有提供 NapCat WebSocket 地址时抛出，避免带着无效凭证启动。
 */
export function resolveConfig(
  options: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
  onWarning: ConfigWarning = () => {},
): QQBotConfig {
  const warnings: string[] = []
  const base = fromEnv(env, warnings)
  const napcat = (options["napcat"] ?? {}) as Record<string, unknown>
  const proactive = (options["proactive"] ?? {}) as Record<string, unknown>
  const reminder = (options["reminder"] ?? {}) as Record<string, unknown>

  const url = asString(napcat["url"]) ?? base.napcat.url
  if (!url) {
    throw new Error(
      "未配置 NapCat WebSocket 地址：请设置环境变量 NAPCAT_WS_URL 或插件选项 napcat.url",
    )
  }

  const optionGroups = asGroupList(options["groups"])
  if (options["groups"] !== undefined && optionGroups?.length === 0) {
    warnings.push(`插件选项 groups 解析不出群号：${JSON.stringify(options["groups"])}`)
  }
  const model = parseModelRef(options["model"], (raw) =>
    warnings.push(`插件选项 model 格式无效：${raw}（应为 provider/model[/variant]）`),
  )

  const config: QQBotConfig = {
    napcat: {
      url,
      token: asString(napcat["token"]) ?? base.napcat.token,
    },
    groups: optionGroups ?? base.groups,
    soulPath: asString(options["soulPath"]) ?? base.soulPath,
    agent: asString(options["agent"]) ?? base.agent,
    model: model ?? base.model,
    sendDelayMs: pickNumber(
      "插件选项 sendDelayMs",
      options["sendDelayMs"],
      base.sendDelayMs,
      warnings,
    ),
    warnLength: pickNumber("插件选项 warnLength", options["warnLength"], base.warnLength, warnings),
    reuseSession: pickBoolean(
      "插件选项 reuseSession",
      options["reuseSession"],
      base.reuseSession,
      warnings,
    ),
    busyTimeoutMs: pickNumber(
      "插件选项 busyTimeoutMs",
      options["busyTimeoutMs"],
      base.busyTimeoutMs,
      warnings,
    ),
    proactive: {
      enabled: pickBoolean(
        "插件选项 proactive.enabled",
        proactive["enabled"],
        base.proactive.enabled,
        warnings,
      ),
      silenceThresholdSeconds: pickNumber(
        "插件选项 proactive.silenceThresholdSeconds",
        proactive["silenceThresholdSeconds"],
        base.proactive.silenceThresholdSeconds,
        warnings,
      ),
      startProbability: pickNumber(
        "插件选项 proactive.startProbability",
        proactive["startProbability"],
        base.proactive.startProbability,
        warnings,
      ),
      probabilityPerHour: pickNumber(
        "插件选项 proactive.probabilityPerHour",
        proactive["probabilityPerHour"],
        base.proactive.probabilityPerHour,
        warnings,
      ),
      tickSeconds: pickPositive(
        "插件选项 proactive.tickSeconds",
        proactive["tickSeconds"],
        base.proactive.tickSeconds,
        warnings,
      ),
    },
    reminder: {
      enabled: pickBoolean(
        "插件选项 reminder.enabled",
        reminder["enabled"],
        base.reminder.enabled,
        warnings,
      ),
      max: pickNumber("插件选项 reminder.max", reminder["max"], base.reminder.max, warnings),
    },
  }

  for (const warning of warnings) onWarning(warning)
  return config
}
