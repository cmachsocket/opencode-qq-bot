import { Model } from "@opencode/schema"
import { z } from "zod"

/**
 * Plugin configuration: merges OpenCode plugin options, environment variables
 * and built-in defaults into a single validated object.
 *
 * Credentials are never stored in the repository: the NapCat endpoint and token
 * must be supplied through the environment or through plugin options.
 */

const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/
const TRUTHY = new Set(["1", "true", "yes", "on"])
const BOOLEAN_SPELLINGS = ["1", "0", "true", "false", "yes", "no", "on", "off"] as const

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

export interface KeepAliveConfig {
  /** 是否启用保活心跳。 */
  enabled: boolean
  /** 保活心跳间隔（秒），必须小于 OpenCode 的 location 空闲超时。 */
  seconds: number
}

export interface HistoryConfig {
  /** 新建会话时补齐的历史消息条数，0 表示关闭。 */
  count: number
}

export interface RateLimitConfig {
  /** 每分钟最多发出多少条消息，0 表示不限制。 */
  maxPerMinute: number
  /** 每小时最多发出多少条消息，0 表示不限制。 */
  maxPerHour: number
  /** 相邻两次发送之间的最小间隔（毫秒），0 表示不限制。 */
  minGapMs: number
}

export interface SensitiveConfig {
  /** 是否拦截含敏感信息（凭证、令牌）的出站消息。 */
  enabled: boolean
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
  /** 参与 AI 对话的私聊 QQ 号。 */
  users: number[]
  /** 角色设定文件路径，默认使用插件包内的 souls 目录。 */
  soulPath?: string
  /** souls 目录里的角色设定文件名，默认 default.txt。 */
  soulName?: string
  /** 机器人会话统一使用的工作目录，默认使用 XDG 数据目录下的工作区。 */
  home?: string
  /** QQ 会话使用的 OpenCode agent。 */
  agent?: string
  /** QQ 会话使用的模型。 */
  model?: ModelRef
  /** 拆行发送时每条消息之间的间隔（毫秒）。 */
  sendDelayMs: number
  /** 单次发送的内容超过该长度时告警（不截断）。 */
  warnLength: number
  /** 重启后是否复用上一次的会话。 */
  reuseSession: boolean
  proactive: ProactiveConfig
  reminder: ReminderConfig
  keepAlive: KeepAliveConfig
  history: HistoryConfig
  rateLimit: RateLimitConfig
  sensitive: SensitiveConfig
}

/** 除 NapCat 连接信息外的全部默认值。 */
export const DEFAULT_CONFIG: Omit<QQBotConfig, "napcat"> = {
  groups: [],
  users: [],
  sendDelayMs: 1000,
  warnLength: 500,
  reuseSession: false,
  proactive: {
    enabled: true,
    silenceThresholdSeconds: 3 * 3600,
    startProbability: 0.01,
    probabilityPerHour: 0.05,
    tickSeconds: 3600,
  },
  reminder: { enabled: true, max: 2 },
  keepAlive: { enabled: true, seconds: 20 * 60 },
  history: { count: 20 },
  rateLimit: { maxPerMinute: 8, maxPerHour: 60, minGapMs: 1500 },
  sensitive: { enabled: true },
}

/** 配置告警回调。 */
export type ConfigWarning = (message: string) => void

/** 解析 "provider/model" 或 "provider/model/variant"，复用 SDK 的模型引用解析。 */
function parseModelRef(value: unknown): ModelRef | undefined {
  const raw = typeof value === "string" ? value.trim() : ""
  if (!raw) return undefined
  const [providerID, id, variant, ...rest] = raw.split("/").filter(Boolean)
  if (!providerID || !id || rest.length > 0) return undefined
  try {
    const ref = Model.Ref.parse(`${providerID}/${id}${variant ? `#${variant}` : ""}`)
    return {
      providerID: ref.providerID,
      id: ref.id,
      ...(ref.variant ? { variant: ref.variant } : {}),
    }
  } catch {
    return undefined
  }
}

/** 判断值是否算“已提供”，用于区分空值与写错的值。 */
function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ""
}

/** 把数字数组或逗号分隔字符串整理成去重后的正整数列表。 */
function toIds(
  value: unknown,
  warn: ConfigWarning,
  label: string,
  noun: string,
): number[] | undefined {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : undefined
  if (!source) return undefined
  const ids: number[] = []
  const seen = new Set<number>()
  for (const entry of source) {
    const raw =
      typeof entry === "number" ? String(entry) : typeof entry === "string" ? entry.trim() : ""
    if (!raw) continue
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      warn(`${label} 忽略非法${noun}：${raw}`)
      continue
    }
    if (seen.has(parsed)) continue
    seen.add(parsed)
    ids.push(parsed)
  }
  return ids
}

interface PartialNapcatConfig {
  url?: string
  token?: string
}

type RawConfig = Omit<QQBotConfig, "napcat"> & { napcat: PartialNapcatConfig }

/**
 * 用同一份字段清单生成配置 schema。
 *
 * `defaults` 是被覆盖层的兜底值，因此环境变量层用 `DEFAULT_CONFIG`，
 * 插件选项层用解析后的环境变量配置，天然实现“选项 > 环境变量 > 默认值”。
 */
function createConfigSchema(
  defaults: Omit<QQBotConfig, "napcat">,
  napcat: PartialNapcatConfig,
  label: (path: string) => string,
  warn: ConfigWarning,
): z.ZodType<RawConfig> {
  const number = (path: string, fallback: number) =>
    z
      .union([z.number(), z.string().trim().regex(NUMBER).transform(Number)])
      .pipe(z.number().finite())
      .catch((ctx) => {
        if (present(ctx.value)) warn(`${label(path)} 不是合法的数字：${String(ctx.value)}`)
        return fallback
      })
      .default(fallback)

  const constrained = (
    path: string,
    fallback: number,
    check: (value: z.ZodNumber) => z.ZodNumber,
    rule: string,
  ) =>
    number(path, fallback)
      .pipe(check(z.number()))
      .catch((ctx) => {
        if (present(ctx.value)) {
          warn(`${label(path)} ${rule}，当前为 ${String(ctx.value)}，已回退到 ${fallback}`)
        }
        return fallback
      })

  const positive = (path: string, fallback: number) =>
    constrained(path, fallback, (value) => value.positive(), "必须大于 0")

  const nonNegative = (path: string, fallback: number) =>
    constrained(path, fallback, (value) => value.min(0), "不能小于 0")

  const integer = (path: string, fallback: number, min: number) =>
    constrained(path, fallback, (value) => value.int().min(min), `必须是大于等于 ${min} 的整数`)

  const probability = (path: string, fallback: number) =>
    constrained(path, fallback, (value) => value.min(0).max(1), "必须在 0 到 1 之间")

  const boolean = (path: string, fallback: boolean) =>
    z
      .union([z.boolean(), z.string().trim().toLowerCase().pipe(z.enum(BOOLEAN_SPELLINGS))])
      .transform((value) => (typeof value === "boolean" ? value : TRUTHY.has(value)))
      .catch((ctx) => {
        if (present(ctx.value)) warn(`${label(path)} 不是合法的布尔值：${String(ctx.value)}`)
        return fallback
      })
      .default(fallback)

  const text = (path: string, fallback: string | undefined) =>
    z
      .unknown()
      .optional()
      .transform((value) => {
        if (!present(value)) return fallback
        if (typeof value !== "string") {
          warn(`${label(path)} 必须是字符串：${String(value)}`)
          return fallback
        }
        const trimmed = value.trim()
        if (!trimmed) {
          warn(`${label(path)} 不能为空，已回退到默认值`)
          return fallback
        }
        return trimmed
      })

  const groups = z
    .unknown()
    .optional()
    .transform((value) => {
      if (value === undefined || value === null) return [...defaults.groups]
      const parsed = toIds(value, warn, label("groups"), "群号")
      if (!parsed) {
        if (present(value)) warn(`${label("groups")} 解析不出群号：${String(value)}`)
        return [...defaults.groups]
      }
      return parsed
    })

  const users = z
    .unknown()
    .optional()
    .transform((value) => {
      if (value === undefined || value === null) return [...defaults.users]
      const parsed = toIds(value, warn, label("users"), "QQ 号")
      if (!parsed) {
        if (present(value)) warn(`${label("users")} 解析不出 QQ 号：${String(value)}`)
        return [...defaults.users]
      }
      return parsed
    })

  const model = z
    .unknown()
    .optional()
    .transform((value) => {
      if (!present(value)) return defaults.model
      const parsed = parseModelRef(value)
      if (!parsed) {
        warn(`${label("model")} 格式无效：${String(value)}（应为 provider/model[/variant]）`)
        return defaults.model
      }
      return parsed
    })

  return z.object({
    napcat: z
      .object({
        url: text("napcat.url", napcat.url),
        token: text("napcat.token", napcat.token),
      })
      .prefault({})
      .catch({ url: napcat.url, token: napcat.token }),
    groups,
    users,
    soulPath: text("soulPath", defaults.soulPath),
    soulName: text("soulName", defaults.soulName),
    home: text("home", defaults.home),
    agent: text("agent", defaults.agent),
    model,
    sendDelayMs: nonNegative("sendDelayMs", defaults.sendDelayMs),
    warnLength: integer("warnLength", defaults.warnLength, 1),
    reuseSession: boolean("reuseSession", defaults.reuseSession),
    proactive: z
      .object({
        enabled: boolean("proactive.enabled", defaults.proactive.enabled),
        silenceThresholdSeconds: nonNegative(
          "proactive.silenceThresholdSeconds",
          defaults.proactive.silenceThresholdSeconds,
        ),
        startProbability: probability(
          "proactive.startProbability",
          defaults.proactive.startProbability,
        ),
        probabilityPerHour: probability(
          "proactive.probabilityPerHour",
          defaults.proactive.probabilityPerHour,
        ),
        tickSeconds: positive("proactive.tickSeconds", defaults.proactive.tickSeconds),
      })
      .prefault({})
      .catch(defaults.proactive),
    reminder: z
      .object({
        enabled: boolean("reminder.enabled", defaults.reminder.enabled),
        max: integer("reminder.max", defaults.reminder.max, 0),
      })
      .prefault({})
      .catch(defaults.reminder),
    keepAlive: z
      .object({
        enabled: boolean("keepAlive.enabled", defaults.keepAlive.enabled),
        seconds: positive("keepAlive.seconds", defaults.keepAlive.seconds),
      })
      .prefault({})
      .catch(defaults.keepAlive),
    history: z
      .object({
        count: nonNegative("history.count", defaults.history.count),
      })
      .prefault({})
      .catch(defaults.history),
    rateLimit: z
      .object({
        maxPerMinute: nonNegative("rateLimit.maxPerMinute", defaults.rateLimit.maxPerMinute),
        maxPerHour: nonNegative("rateLimit.maxPerHour", defaults.rateLimit.maxPerHour),
        minGapMs: nonNegative("rateLimit.minGapMs", defaults.rateLimit.minGapMs),
      })
      .prefault({})
      .catch(defaults.rateLimit),
    sensitive: z
      .object({
        enabled: boolean("sensitive.enabled", defaults.sensitive.enabled),
      })
      .prefault({})
      .catch(defaults.sensitive),
  })
}

/** 配置项到环境变量名的映射。 */
export const ENV_VARS = {
  "napcat.url": "NAPCAT_WS_URL",
  "napcat.token": "NAPCAT_WS_TOKEN",
  groups: "QQ_TARGET_GROUPS",
  users: "QQ_TARGET_USERS",
  soulPath: "QQ_BOT_SOUL_PATH",
  soulName: "QQ_BOT_SOUL_NAME",
  home: "QQ_BOT_HOME",
  agent: "QQ_BOT_AGENT",
  model: "QQ_BOT_MODEL",
  sendDelayMs: "QQ_SEND_DELAY_MS",
  warnLength: "QQ_WARN_LENGTH",
  reuseSession: "QQ_REUSE_SESSION",
  "proactive.enabled": "QQ_PROACTIVE_ENABLED",
  "proactive.silenceThresholdSeconds": "QQ_PROACTIVE_SILENCE_SECONDS",
  "proactive.startProbability": "QQ_PROACTIVE_P_START",
  "proactive.probabilityPerHour": "QQ_PROACTIVE_P_SLOPE_PER_HOUR",
  "proactive.tickSeconds": "QQ_PROACTIVE_TICK_SECONDS",
  "reminder.enabled": "QQ_REMINDER_ENABLED",
  "reminder.max": "QQ_REMINDER_MAX",
  "keepAlive.enabled": "QQ_KEEP_ALIVE_ENABLED",
  "keepAlive.seconds": "QQ_KEEP_ALIVE_SECONDS",
  "history.count": "QQ_HISTORY_COUNT",
  "rateLimit.maxPerMinute": "QQ_RATE_MAX_PER_MINUTE",
  "rateLimit.maxPerHour": "QQ_RATE_MAX_PER_HOUR",
  "rateLimit.minGapMs": "QQ_RATE_MIN_GAP_MS",
  "sensitive.enabled": "QQ_SENSITIVE_ENABLED",
} as const

const OPTION_KEYS = new Set([
  "napcat",
  "groups",
  "users",
  "soulPath",
  "soulName",
  "home",
  "agent",
  "model",
  "sendDelayMs",
  "warnLength",
  "reuseSession",
  "proactive",
  "reminder",
  "keepAlive",
  "history",
  "rateLimit",
  "sensitive",
])

const NESTED_OPTION_KEYS: Record<string, ReadonlySet<string>> = {
  napcat: new Set(["url", "token"]),
  proactive: new Set([
    "enabled",
    "silenceThresholdSeconds",
    "startProbability",
    "probabilityPerHour",
    "tickSeconds",
  ]),
  reminder: new Set(["enabled", "max"]),
  keepAlive: new Set(["enabled", "seconds"]),
  history: new Set(["count"]),
  rateLimit: new Set(["maxPerMinute", "maxPerHour", "minGapMs"]),
  sensitive: new Set(["enabled"]),
}

/** 报告被 schema 静默剥离的未知配置项。 */
function warnUnknownKeys(options: Record<string, unknown>, warn: ConfigWarning): void {
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      warn(`插件选项 未知配置项：${key}`)
      continue
    }
    const allowed = NESTED_OPTION_KEYS[key]
    const value = options[key]
    if (!allowed || !value || typeof value !== "object" || Array.isArray(value)) continue
    for (const nested of Object.keys(value)) {
      if (!allowed.has(nested)) warn(`插件选项 ${key}.${nested} 未知配置项`)
    }
  }
}

function envLabel(path: string): string {
  return ENV_VARS[path as keyof typeof ENV_VARS] ?? path
}

function fromEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const [path, name] of Object.entries(ENV_VARS)) {
    const value = env[name]
    if (value === undefined) continue
    const keys = path.split(".")
    const leaf = keys.pop()
    if (!leaf) continue
    let target = config
    for (const key of keys) {
      const child = target[key]
      const next = child && typeof child === "object" ? (child as Record<string, unknown>) : {}
      target[key] = next
      target = next
    }
    target[leaf] = value
  }
  return config
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
  const warn: ConfigWarning = (message) => warnings.push(message)

  warnUnknownKeys(options, warn)
  const envSchema = createConfigSchema(DEFAULT_CONFIG, {}, envLabel, warn)
  const base: RawConfig = envSchema.parse(fromEnv(env))
  const optionsSchema = createConfigSchema(base, base.napcat, (path) => `插件选项 ${path}`, warn)
  const parsed: RawConfig = optionsSchema.parse(options)

  // 先输出告警，避免 URL 缺失时把已经发现的问题一起吞掉。
  for (const warning of warnings) onWarning(warning)

  const url = parsed.napcat.url
  if (!url) {
    throw new Error(
      "未配置 NapCat WebSocket 地址：请设置环境变量 NAPCAT_WS_URL 或插件选项 napcat.url",
    )
  }

  return {
    ...parsed,
    groups: [...parsed.groups],
    users: [...parsed.users],
    proactive: { ...parsed.proactive },
    reminder: { ...parsed.reminder },
    keepAlive: { ...parsed.keepAlive },
    history: { ...parsed.history },
    rateLimit: { ...parsed.rateLimit },
    sensitive: { ...parsed.sensitive },
    napcat: { url, token: parsed.napcat.token },
  }
}
