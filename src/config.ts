import { Model } from "@opencode/schema"
import { z } from "zod"
import type { LogLevel } from "./logger"

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
/** 合法的日志级别。 */
const LOG_LEVELS: readonly string[] = ["debug", "info", "warn", "error"]
/** 可订阅的事件类别。 */
export const EVENT_CATEGORIES: readonly string[] = ["message", "notice"]

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

/** 日志配置。 */
export interface LogConfig {
  /** 最低日志级别。 */
  level: LogLevel
  /** 日志目录，空表示用 XDG 状态目录。 */
  dir: string
  /** 单个日志文件的大小上限。 */
  maxSize: string
  /** 保留的历史日志份数。 */
  maxFiles: number
}

/** 事件订阅配置。 */
export interface EventsConfig {
  /** 订阅哪些事件类别：`message` / `notice`。 */
  subscribe: string[]
  /** notice 类别里具体关心哪些通知；留空表示全收。 */
  notices: string[]
  /** 通知是否注入会话上下文。 */
  inject: boolean
}

/** 媒体配置。 */
export interface MediaConfig {
  /** 额外允许发送媒体的目录。 */
  allowedDirs: string[]
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
  /** 机器人所有者 QQ 号：可用管理命令，并拥有全部工具权限。 */
  ownerQQ?: number
  /** 管理员 QQ 号：拥有全部工具权限。 */
  admins: number[]
  /** 工具配置文件路径，空表示当前工作目录下的 `tool-profiles.json`。 */
  toolProfilesPath?: string
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
  events: EventsConfig
  log: LogConfig
  media: MediaConfig
}

/** 除 NapCat 连接信息外的全部默认值。 */
export const DEFAULT_CONFIG: Omit<QQBotConfig, "napcat"> = {
  groups: [],
  users: [],
  admins: [],
  toolProfilesPath: "",
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
  events: { subscribe: ["message"], notices: [], inject: true },
  log: { level: "info", dir: "", maxSize: "5m", maxFiles: 5 },
  media: { allowedDirs: [] },
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

  /** 必填的字符串：空值或非法值都回退到默认值。 */
  const requiredText = (path: string, fallback: string) =>
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

  /** 日志级别：只认 debug/info/warn/error，写错就回退到默认值。 */
  const logLevel = (path: string, fallback: LogLevel) =>
    z
      .unknown()
      .optional()
      .transform((value) => {
        if (!present(value)) return fallback
        const raw = typeof value === "string" ? value.trim().toLowerCase() : ""
        if (!raw) {
          warn(`${label(path)} 不能为空，已回退到默认值`)
          return fallback
        }
        if (!LOG_LEVELS.includes(raw)) {
          warn(
            `${label(path)} 不是合法的日志级别：${String(value)}（可用：${LOG_LEVELS.join("/")}）`,
          )
          return fallback
        }
        return raw as LogLevel
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

  const admins = z
    .unknown()
    .optional()
    .transform((value) => {
      if (value === undefined || value === null) return [...defaults.admins]
      const parsed = toIds(value, warn, label("admins"), "QQ 号")
      if (!parsed) {
        if (present(value)) warn(`${label("admins")} 解析不出 QQ 号：${String(value)}`)
        return [...defaults.admins]
      }
      return parsed
    })

  const ownerQQ = z
    .unknown()
    .optional()
    .transform((value) => {
      if (!present(value)) return defaults.ownerQQ
      const parsed = Number(typeof value === "string" ? value.trim() : value)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        warn(`${label("ownerQQ")} 不是合法的 QQ 号：${String(value)}`)
        return defaults.ownerQQ
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

  /** 事件订阅列表：数组或逗号分隔字符串。 */
  const eventList = (path: string, fallback: readonly string[]) =>
    z
      .unknown()
      .optional()
      .transform((value) => {
        if (value === undefined || value === null) return [...fallback]
        const source = Array.isArray(value)
          ? value
          : typeof value === "string"
            ? value.split(",")
            : undefined
        if (!source) {
          if (present(value)) {
            warn(`${label(path)} 必须是字符串或字符串数组：${String(value)}`)
          }
          return [...fallback]
        }
        const items: string[] = []
        for (const entry of source) {
          const raw = typeof entry === "string" ? entry.trim() : ""
          if (!raw) continue
          if (items.includes(raw)) continue
          items.push(raw)
        }
        return items
      })

  /** 允许发送媒体的目录：数组或逗号分隔字符串。 */
  const mediaDirs = z
    .unknown()
    .optional()
    .transform((value) => {
      if (value === undefined || value === null) return [...defaults.media.allowedDirs]
      const source = Array.isArray(value)
        ? value
        : typeof value === "string"
          ? value.split(",")
          : undefined
      if (!source) {
        if (present(value)) {
          warn(`${label("media.allowedDirs")} 必须是字符串或字符串数组：${String(value)}`)
        }
        return [...defaults.media.allowedDirs]
      }
      const dirs: string[] = []
      for (const entry of source) {
        const raw = typeof entry === "string" ? entry.trim() : ""
        if (!raw) continue
        if (dirs.includes(raw)) continue
        dirs.push(raw)
      }
      return dirs
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
    admins,
    ownerQQ,
    toolProfilesPath: text("toolProfilesPath", defaults.toolProfilesPath),
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
    events: z
      .object({
        subscribe: eventList("events.subscribe", defaults.events.subscribe),
        notices: eventList("events.notices", defaults.events.notices),
        inject: boolean("events.inject", defaults.events.inject),
      })
      .prefault({
        subscribe: [...defaults.events.subscribe],
        notices: [...defaults.events.notices],
      })
      .catch(defaults.events),
    log: z
      .object({
        level: logLevel("log.level", defaults.log.level),
        dir: z
          .unknown()
          .optional()
          .transform((value) => {
            if (value === undefined || value === null) return defaults.log.dir
            if (typeof value !== "string") {
              warn(`${label("log.dir")} 必须是字符串：${String(value)}`)
              return defaults.log.dir
            }
            // 空目录是有意义的：表示用 XDG 状态目录。
            return value.trim()
          }),
        maxSize: requiredText("log.maxSize", defaults.log.maxSize),
        maxFiles: integer("log.maxFiles", defaults.log.maxFiles, 1),
      })
      .prefault({})
      .catch(defaults.log),
    media: z
      .object({
        allowedDirs: mediaDirs,
      })
      .prefault({})
      .catch(defaults.media),
  })
}

/** 配置项到环境变量名的映射。 */
export const ENV_VARS = {
  "napcat.url": "NAPCAT_WS_URL",
  "napcat.token": "NAPCAT_WS_TOKEN",
  groups: "QQ_TARGET_GROUPS",
  users: "QQ_TARGET_USERS",
  ownerQQ: "QQ_OWNER_QQ",
  admins: "QQ_ADMINS",
  toolProfilesPath: "QQ_TOOL_PROFILES",
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
  "events.subscribe": "QQ_EVENT_SUBSCRIBE",
  "events.notices": "QQ_EVENT_NOTICES",
  "events.inject": "QQ_EVENT_INJECT",
  "log.level": "QQ_LOG_LEVEL",
  "log.dir": "QQ_LOG_DIR",
  "log.maxSize": "QQ_LOG_MAX_SIZE",
  "log.maxFiles": "QQ_LOG_MAX_FILES",
  "media.allowedDirs": "QQ_MEDIA_ALLOWED_DIRS",
} as const

const OPTION_KEYS = new Set([
  "napcat",
  "groups",
  "users",
  "ownerQQ",
  "admins",
  "toolProfilesPath",
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
  "events",
  "log",
  "media",
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
  events: new Set(["subscribe", "notices", "inject"]),
  log: new Set(["level", "dir", "maxSize", "maxFiles"]),
  media: new Set(["allowedDirs"]),
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

  // 只保留认识的事件类别：写错的类别直接告警，不静默失效。
  const subscribe: string[] = []
  for (const category of parsed.events.subscribe) {
    if (!EVENT_CATEGORIES.includes(category)) {
      warn(`events.subscribe 忽略未知类别：${category}`)
      continue
    }
    if (!subscribe.includes(category)) subscribe.push(category)
  }

  // 先输出告警，避免 URL 缺失时把已经发现的问题一起吞掉。
  for (const warning of warnings) onWarning(warning)

  const url = parsed.napcat.url
  if (!url) {
    throw new Error(
      "未配置 NapCat WebSocket 地址：请设置环境变量 NAPCAT_WS_URL 或插件选项 napcat.url",
    )
  }

  // owner 必须能私聊到机器人，否则管理命令无处触发；没写进 users 时自动补上。
  const users = [...parsed.users]
  if (parsed.ownerQQ !== undefined && !users.includes(parsed.ownerQQ)) users.push(parsed.ownerQQ)

  return {
    ...parsed,
    groups: [...parsed.groups],
    users,
    admins: [...parsed.admins],
    proactive: { ...parsed.proactive },
    reminder: { ...parsed.reminder },
    keepAlive: { ...parsed.keepAlive },
    history: { ...parsed.history },
    rateLimit: { ...parsed.rateLimit },
    sensitive: { ...parsed.sensitive },
    events: {
      subscribe,
      notices: [...parsed.events.notices],
      inject: parsed.events.inject,
    },
    log: { ...parsed.log },
    media: { allowedDirs: [...parsed.media.allowedDirs] },
    napcat: { url, token: parsed.napcat.token },
  }
}
