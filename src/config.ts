import { Model } from "@opencode/schema"
import { z } from "zod"
import type { AccessConfig } from "./access"
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
const EVENT_CATEGORIES: readonly string[] = ["message", "notice"]

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
  /** 只在这些群里主动说话；为空表示不限制。 */
  allowGroups: number[]
  /** 只在这些私聊里主动说话；为空表示不限制。 */
  allowUsers: number[]
}

/** 唤醒判定配置：全局的触发条件。 */
export interface WakeConfig {
  /** 全局唤醒前缀，命中即必回。 */
  prefixes: string[]
  /** 是否忽略 @全体成员。 */
  ignoreAtAll: boolean
  /** 回复机器人自己的消息是否必回。 */
  replyToSelf: boolean
  /** 群里第一条 @ 的是别人时是否不唤醒机器人。 */
  ignoreAtOthers: boolean
}

/** 回复节奏配置：怎么拆段、怎么发。 */
export interface ReplyConfig {
  /** 分段之间的最小间隔（毫秒）。 */
  minDelayMs: number
  /** 分段之间的最大间隔（毫秒），0 表示沿用 `sendDelayMs`。 */
  maxDelayMs: number
  /** 单条消息超过该字数就拆成多段发送。 */
  segmentChars: number
  /** 单条回复超过该字数就改用合并转发，0 表示关闭。 */
  forwardThresholdChars: number
  /** 是否要求模型先说明理由才能发送：默认开启。 */
  requirePermission: boolean
}

/** 调用链追踪配置。 */
export interface TraceConfig {
  /** 是否记录调用链追踪。 */
  enabled: boolean
  /** 追踪文件目录，空表示与日志同目录。 */
  dir: string
  /** 追踪文件总容量上限（MB）。 */
  maxSizeMb: number
  /** 追踪文件保留天数。 */
  retentionDays: number
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
  /** 触顶时是否等窗口结束再发；关闭时直接拒绝这次发送。 */
  stall: boolean
  /** 单次等待窗口结束的上限（毫秒）。 */
  stallMaxWaitMs: number
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
  /** 准入配置：放行名单、拒绝名单与名单为空时的行为。 */
  access: AccessConfig
  /** 机器人所有者 QQ 号：可用管理命令，并拥有全部工具权限。 */
  ownerQQ?: number
  /** 管理员 QQ 号：拥有全部工具权限。 */
  admins: number[]
  /** 工具配置文件路径；相对路径按机器人工作目录解析，空表示工作目录下的 `tool-profiles.json`。 */
  toolProfilesPath?: string
  /** 会话行为覆盖文件路径；相对路径按机器人工作目录解析，空表示工作目录下的 `chat-overrides.json`。 */
  chatOverridesPath?: string
  /** 角色设定文件路径；相对路径按机器人工作目录解析，默认取工作目录里的 souls/。 */
  soulPath?: string
  /** 工作目录 souls 里的角色设定文件名，默认 default.txt。 */
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
  wake: WakeConfig
  reply: ReplyConfig
  trace: TraceConfig
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
  access: {
    allow: { groups: [], users: [] },
    deny: { groups: [], users: [] },
    allowAllWhenEmpty: false,
  },
  admins: [],
  toolProfilesPath: "",
  chatOverridesPath: "",
  sendDelayMs: 1000,
  warnLength: 500,
  reuseSession: false,
  proactive: {
    enabled: true,
    silenceThresholdSeconds: 3 * 3600,
    startProbability: 0.01,
    probabilityPerHour: 0.05,
    tickSeconds: 3600,
    allowGroups: [],
    allowUsers: [],
  },
  wake: { prefixes: ["/"], ignoreAtAll: true, replyToSelf: true, ignoreAtOthers: true },
  reply: {
    minDelayMs: 0,
    maxDelayMs: 0,
    segmentChars: 150,
    forwardThresholdChars: 1500,
    requirePermission: true,
  },
  trace: { enabled: true, dir: "", maxSizeMb: 80, retentionDays: 7 },
  reminder: { enabled: true, max: 2 },
  keepAlive: { enabled: true, seconds: 20 * 60 },
  history: { count: 20 },
  rateLimit: {
    maxPerMinute: 8,
    maxPerHour: 60,
    minGapMs: 1500,
    stall: false,
    stallMaxWaitMs: 60_000,
  },
  sensitive: { enabled: true },
  events: { subscribe: ["message"], notices: [], inject: true },
  log: { level: "info", dir: "", maxSize: "5m", maxFiles: 5 },
  media: { allowedDirs: [] },
}

/** 迁移类告警前缀：启动时用更高等级输出，避免升级用户静默失联。 */
export const MIGRATION_WARNING_PREFIX = "【迁移】"

/** 移除的环境变量与替代项。 */
const RENAMED_ENV_VARS: Record<string, string> = {
  QQ_TARGET_GROUPS: "QQ_ALLOW_GROUPS",
  QQ_TARGET_USERS: "QQ_ALLOW_USERS",
}

/** 配置告警回调。 */
export type ConfigWarning = (message: string) => void

/** 解析 "provider/model" 或 "provider/model/variant"，复用 SDK 的模型引用解析。 */
export function parseModelRef(value: unknown): ModelRef | undefined {
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

/** 把「数组或逗号分隔字符串」统一成数组；其它类型返回 undefined。 */
function toSource(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value
  return typeof value === "string" ? value.split(",") : undefined
}

/** 把数字数组或逗号分隔字符串整理成去重后的正整数列表。 */
function toIds(
  value: unknown,
  warn: ConfigWarning,
  label: string,
  noun: string,
): number[] | undefined {
  const source = toSource(value)
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

  /**
   * 字符串：空值或非法值都回退到默认值。
   *
   * 返回类型跟随 fallback：给 `undefined` 表示可以不配置（如 napcat.url），
   * 给实串就是必填（如 log.maxSize）。
   */
  const text = <T extends string | undefined>(path: string, fallback: T) =>
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

  /** 编号名单：数组或逗号分隔字符串。 */
  const idList = (path: string, fallback: readonly number[], noun: string) =>
    z
      .unknown()
      .optional()
      .transform((value) => {
        if (value === undefined || value === null) return [...fallback]
        const parsed = toIds(value, warn, label(path), noun)
        if (!parsed) {
          if (present(value)) warn(`${label(path)} 解析不出${noun}：${String(value)}`)
          return [...fallback]
        }
        return parsed
      })

  const admins = idList("admins", defaults.admins, "QQ 号")

  const ownerQQ = z
    .unknown()
    .optional()
    .transform((value) => {
      if (!present(value)) return defaults.ownerQQ
      // 只接受数字或非空数字字符串：布尔值经 Number() 会变成 0/1。
      const parsed =
        typeof value === "number"
          ? value
          : typeof value === "string" && value.trim() !== ""
            ? Number(value.trim())
            : Number.NaN
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

  /** 字符串列表：数组或逗号分隔字符串。 */
  const stringList = (path: string, fallback: readonly string[]) =>
    z
      .unknown()
      .optional()
      .transform((value) => {
        if (value === undefined || value === null) return [...fallback]
        const source = toSource(value)
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

  /** 允许发送媒体的目录。 */
  const mediaDirs = stringList("media.allowedDirs", defaults.media.allowedDirs)

  /** 可选目录：空串有意义（由调用方解释为默认位置），非字符串回退到默认值。 */
  const optionalDir = (path: string, fallback: string) =>
    z
      .unknown()
      .optional()
      .transform((value) => {
        if (value === undefined || value === null) return fallback
        if (typeof value !== "string") {
          warn(`${label(path)} 必须是字符串：${String(value)}`)
          return fallback
        }
        return value.trim()
      })

  return z.object({
    napcat: z
      .object({
        url: text("napcat.url", napcat.url),
        token: text("napcat.token", napcat.token),
      })
      .prefault({})
      .catch({ url: napcat.url, token: napcat.token }),
    access: z
      .object({
        allow: z
          .object({
            groups: idList("access.allow.groups", defaults.access.allow.groups, "群号").default([
              ...defaults.access.allow.groups,
            ]),
            users: idList("access.allow.users", defaults.access.allow.users, "QQ 号").default([
              ...defaults.access.allow.users,
            ]),
          })
          .prefault({})
          .catch({
            groups: [...defaults.access.allow.groups],
            users: [...defaults.access.allow.users],
          }),
        deny: z
          .object({
            groups: idList("access.deny.groups", defaults.access.deny.groups, "群号").default([
              ...defaults.access.deny.groups,
            ]),
            users: idList("access.deny.users", defaults.access.deny.users, "QQ 号").default([
              ...defaults.access.deny.users,
            ]),
          })
          .prefault({})
          .catch({
            groups: [...defaults.access.deny.groups],
            users: [...defaults.access.deny.users],
          }),
        allowAllWhenEmpty: boolean("access.allowAllWhenEmpty", defaults.access.allowAllWhenEmpty),
      })
      .prefault({})
      .catch(defaults.access),
    admins,
    ownerQQ,
    toolProfilesPath: text("toolProfilesPath", defaults.toolProfilesPath),
    chatOverridesPath: text("chatOverridesPath", defaults.chatOverridesPath),
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
        allowGroups: idList(
          "proactive.allowGroups",
          defaults.proactive.allowGroups,
          "群号",
        ).default([...defaults.proactive.allowGroups]),
        allowUsers: idList("proactive.allowUsers", defaults.proactive.allowUsers, "QQ 号").default([
          ...defaults.proactive.allowUsers,
        ]),
      })
      .prefault({})
      .catch(defaults.proactive),
    wake: z
      .object({
        prefixes: stringList("wake.prefixes", defaults.wake.prefixes).default([
          ...defaults.wake.prefixes,
        ]),
        ignoreAtAll: boolean("wake.ignoreAtAll", defaults.wake.ignoreAtAll),
        replyToSelf: boolean("wake.replyToSelf", defaults.wake.replyToSelf),
        ignoreAtOthers: boolean("wake.ignoreAtOthers", defaults.wake.ignoreAtOthers),
      })
      .prefault({})
      .catch(defaults.wake),
    reply: z
      .object({
        minDelayMs: nonNegative("reply.minDelayMs", defaults.reply.minDelayMs),
        maxDelayMs: nonNegative("reply.maxDelayMs", defaults.reply.maxDelayMs),
        segmentChars: integer("reply.segmentChars", defaults.reply.segmentChars, 1),
        forwardThresholdChars: nonNegative(
          "reply.forwardThresholdChars",
          defaults.reply.forwardThresholdChars,
        ),
        requirePermission: boolean("reply.requirePermission", defaults.reply.requirePermission),
      })
      .prefault({})
      .catch(defaults.reply),
    trace: z
      .object({
        enabled: boolean("trace.enabled", defaults.trace.enabled),
        dir: optionalDir("trace.dir", defaults.trace.dir),
        maxSizeMb: positive("trace.maxSizeMb", defaults.trace.maxSizeMb),
        retentionDays: integer("trace.retentionDays", defaults.trace.retentionDays, 1),
      })
      .prefault({})
      .catch(defaults.trace),
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
        stall: boolean("rateLimit.stall", defaults.rateLimit.stall),
        stallMaxWaitMs: nonNegative("rateLimit.stallMaxWaitMs", defaults.rateLimit.stallMaxWaitMs),
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
        subscribe: stringList("events.subscribe", defaults.events.subscribe),
        notices: stringList("events.notices", defaults.events.notices),
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
        dir: optionalDir("log.dir", defaults.log.dir),
        maxSize: text("log.maxSize", defaults.log.maxSize),
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
  "access.allow.groups": "QQ_ALLOW_GROUPS",
  "access.allow.users": "QQ_ALLOW_USERS",
  "access.deny.groups": "QQ_DENY_GROUPS",
  "access.deny.users": "QQ_DENY_USERS",
  "access.allowAllWhenEmpty": "QQ_ALLOW_ALL_WHEN_EMPTY",
  ownerQQ: "QQ_OWNER_QQ",
  admins: "QQ_ADMINS",
  toolProfilesPath: "QQ_TOOL_PROFILES",
  chatOverridesPath: "QQ_CHAT_OVERRIDES",
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
  "proactive.allowGroups": "QQ_PROACTIVE_ALLOW_GROUPS",
  "proactive.allowUsers": "QQ_PROACTIVE_ALLOW_USERS",
  "wake.prefixes": "QQ_WAKE_PREFIXES",
  "wake.ignoreAtAll": "QQ_WAKE_IGNORE_AT_ALL",
  "wake.replyToSelf": "QQ_WAKE_REPLY_TO_SELF",
  "wake.ignoreAtOthers": "QQ_WAKE_IGNORE_AT_OTHERS",
  "reply.minDelayMs": "QQ_REPLY_MIN_DELAY_MS",
  "reply.maxDelayMs": "QQ_REPLY_MAX_DELAY_MS",
  "reply.segmentChars": "QQ_REPLY_SEGMENT_CHARS",
  "reply.forwardThresholdChars": "QQ_REPLY_FORWARD_THRESHOLD_CHARS",
  "reply.requirePermission": "QQ_REPLY_REQUIRE_PERMISSION",
  "trace.enabled": "QQ_TRACE_ENABLED",
  "trace.dir": "QQ_TRACE_DIR",
  "trace.maxSizeMb": "QQ_TRACE_MAX_SIZE_MB",
  "trace.retentionDays": "QQ_TRACE_RETENTION_DAYS",
  "reminder.enabled": "QQ_REMINDER_ENABLED",
  "reminder.max": "QQ_REMINDER_MAX",
  "keepAlive.enabled": "QQ_KEEP_ALIVE_ENABLED",
  "keepAlive.seconds": "QQ_KEEP_ALIVE_SECONDS",
  "history.count": "QQ_HISTORY_COUNT",
  "rateLimit.maxPerMinute": "QQ_RATE_MAX_PER_MINUTE",
  "rateLimit.maxPerHour": "QQ_RATE_MAX_PER_HOUR",
  "rateLimit.minGapMs": "QQ_RATE_MIN_GAP_MS",
  "rateLimit.stall": "QQ_RATE_STALL",
  "rateLimit.stallMaxWaitMs": "QQ_RATE_STALL_MAX_WAIT_MS",
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
  "access",
  "ownerQQ",
  "admins",
  "toolProfilesPath",
  "chatOverridesPath",
  "soulPath",
  "soulName",
  "home",
  "agent",
  "model",
  "sendDelayMs",
  "warnLength",
  "reuseSession",
  "proactive",
  "wake",
  "reply",
  "trace",
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
  access: new Set(["allow", "deny", "allowAllWhenEmpty"]),
  "access.allow": new Set(["groups", "users"]),
  "access.deny": new Set(["groups", "users"]),
  proactive: new Set([
    "enabled",
    "silenceThresholdSeconds",
    "startProbability",
    "probabilityPerHour",
    "tickSeconds",
    "allowGroups",
    "allowUsers",
  ]),
  wake: new Set(["prefixes", "ignoreAtAll", "replyToSelf", "ignoreAtOthers"]),
  reply: new Set([
    "minDelayMs",
    "maxDelayMs",
    "segmentChars",
    "forwardThresholdChars",
    "requirePermission",
  ]),
  trace: new Set(["enabled", "dir", "maxSizeMb", "retentionDays"]),
  reminder: new Set(["enabled", "max"]),
  keepAlive: new Set(["enabled", "seconds"]),
  history: new Set(["count"]),
  rateLimit: new Set(["maxPerMinute", "maxPerHour", "minGapMs", "stall", "stallMaxWaitMs"]),
  sensitive: new Set(["enabled"]),
  events: new Set(["subscribe", "notices", "inject"]),
  log: new Set(["level", "dir", "maxSize", "maxFiles"]),
  media: new Set(["allowedDirs"]),
}

/** 改过名的配置项：给出迁移提示而不是笼统的“未知配置项”。 */
const RENAMED_OPTIONS: Record<string, string> = {
  groups: "access.allow.groups",
  users: "access.allow.users",
}

/**
 * 报告被 schema 静默剥离的未知配置项。
 *
 * 按层级逐层检查：`access.allow.groups` 这类嵌套路径也能报出来。
 */
function warnUnknownKeys(options: Record<string, unknown>, warn: ConfigWarning): void {
  const walk = (value: Record<string, unknown>, path: string): void => {
    const allowed = path === "" ? OPTION_KEYS : NESTED_OPTION_KEYS[path]
    for (const key of Object.keys(value)) {
      const childPath = path ? `${path}.${key}` : key
      if (allowed && !allowed.has(key)) {
        const renamed = RENAMED_OPTIONS[childPath]
        warn(
          renamed
            ? `${MIGRATION_WARNING_PREFIX} 插件选项 ${childPath} 已移除，请改用 ${renamed}`
            : `插件选项 未知配置项：${childPath}`,
        )
        continue
      }
      const child = value[key]
      if (!child || typeof child !== "object" || Array.isArray(child)) continue
      walk(child as Record<string, unknown>, childPath)
    }
  }
  walk(options, "")
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

  // 旧的名单环境变量已经移除：给出醒目的迁移提示，避免升级后机器人静默失联。
  for (const [name, replacement] of Object.entries(RENAMED_ENV_VARS)) {
    if (env[name] !== undefined) {
      warn(
        `${MIGRATION_WARNING_PREFIX} 环境变量 ${name} 已移除，请改用 ${replacement}；未迁移时机器人不会响应任何消息`,
      )
    }
  }

  // owner 必须能私聊到机器人，否则管理命令无处触发：拒绝名单里的 owner 豁免。
  const denyUsers = [...parsed.access.deny.users]
  if (parsed.ownerQQ !== undefined && denyUsers.includes(parsed.ownerQQ)) {
    warn(`ownerQQ ${parsed.ownerQQ} 在 access.deny.users 里，已豁免：owner 的私聊必须可用`)
    denyUsers.splice(denyUsers.indexOf(parsed.ownerQQ), 1)
  }

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
    access: {
      allow: {
        groups: [...parsed.access.allow.groups],
        users: [...parsed.access.allow.users],
      },
      deny: {
        groups: [...parsed.access.deny.groups],
        users: denyUsers,
      },
      allowAllWhenEmpty: parsed.access.allowAllWhenEmpty,
    },
    admins: [...parsed.admins],
    proactive: {
      ...parsed.proactive,
      allowGroups: [...parsed.proactive.allowGroups],
      allowUsers: [...parsed.proactive.allowUsers],
    },
    wake: { ...parsed.wake, prefixes: [...parsed.wake.prefixes] },
    reply: { ...parsed.reply },
    trace: { ...parsed.trace },
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
