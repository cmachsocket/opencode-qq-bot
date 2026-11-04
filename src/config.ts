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

/** 把数字数组或逗号分隔字符串整理成整数列表。 */
function toGroups(value: unknown): number[] | undefined {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : undefined
  if (!source) return undefined
  const groups: number[] = []
  for (const entry of source) {
    const raw =
      typeof entry === "number" ? String(entry) : typeof entry === "string" ? entry.trim() : ""
    if (!raw) continue
    const parsed = Number(raw)
    if (Number.isInteger(parsed)) groups.push(parsed)
  }
  return groups
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

  const positive = (path: string, fallback: number) =>
    number(path, fallback)
      .pipe(z.number().positive())
      .catch((ctx) => {
        if (present(ctx.value)) {
          warn(`${label(path)} 必须大于 0，当前为 ${String(ctx.value)}，已回退到 ${fallback}`)
        }
        return fallback
      })

  const boolean = (path: string, fallback: boolean) =>
    z
      .union([z.boolean(), z.string().trim().toLowerCase().pipe(z.enum(BOOLEAN_SPELLINGS))])
      .transform((value) => (typeof value === "boolean" ? value : TRUTHY.has(value)))
      .catch((ctx) => {
        if (present(ctx.value)) warn(`${label(path)} 不是合法的布尔值：${String(ctx.value)}`)
        return fallback
      })
      .default(fallback)

  const text = (fallback: string | undefined) =>
    z
      .string()
      .trim()
      .min(1)
      .optional()
      .catch(() => undefined)
      .transform((value) => value ?? fallback)

  const groups = z
    .unknown()
    .optional()
    .transform((value) => {
      if (value === undefined || value === null) return defaults.groups
      const parsed = toGroups(value)
      if (!parsed) {
        if (present(value)) warn(`${label("groups")} 解析不出群号：${String(value)}`)
        return defaults.groups
      }
      if (parsed.length === 0 && present(value) && !(Array.isArray(value) && value.length === 0)) {
        warn(`${label("groups")} 解析不出群号：${String(value)}`)
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
        url: text(napcat.url),
        token: text(napcat.token),
      })
      .prefault({})
      .catch({ url: napcat.url, token: napcat.token }),
    groups,
    soulPath: text(defaults.soulPath),
    agent: text(defaults.agent),
    model,
    sendDelayMs: number("sendDelayMs", defaults.sendDelayMs),
    warnLength: number("warnLength", defaults.warnLength),
    reuseSession: boolean("reuseSession", defaults.reuseSession),
    busyTimeoutMs: number("busyTimeoutMs", defaults.busyTimeoutMs),
    proactive: z
      .object({
        enabled: boolean("proactive.enabled", defaults.proactive.enabled),
        silenceThresholdSeconds: number(
          "proactive.silenceThresholdSeconds",
          defaults.proactive.silenceThresholdSeconds,
        ),
        startProbability: number("proactive.startProbability", defaults.proactive.startProbability),
        probabilityPerHour: number(
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
        max: number("reminder.max", defaults.reminder.max),
      })
      .prefault({})
      .catch(defaults.reminder),
  })
}

const ENV_VARS = {
  "napcat.url": "NAPCAT_WS_URL",
  "napcat.token": "NAPCAT_WS_TOKEN",
  groups: "QQ_TARGET_GROUPS",
  soulPath: "QQ_BOT_SOUL_PATH",
  agent: "QQ_BOT_AGENT",
  model: "QQ_BOT_MODEL",
  sendDelayMs: "QQ_SEND_DELAY_MS",
  warnLength: "QQ_WARN_LENGTH",
  reuseSession: "QQ_REUSE_SESSION",
  busyTimeoutMs: "QQ_BUSY_TIMEOUT_MS",
  "proactive.enabled": "QQ_PROACTIVE_ENABLED",
  "proactive.silenceThresholdSeconds": "QQ_PROACTIVE_SILENCE_SECONDS",
  "proactive.startProbability": "QQ_PROACTIVE_P_START",
  "proactive.probabilityPerHour": "QQ_PROACTIVE_P_SLOPE_PER_HOUR",
  "proactive.tickSeconds": "QQ_PROACTIVE_TICK_SECONDS",
  "reminder.enabled": "QQ_REMINDER_ENABLED",
  "reminder.max": "QQ_REMINDER_MAX",
} as const

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

  const envSchema = createConfigSchema(DEFAULT_CONFIG, {}, envLabel, warn)
  const base: RawConfig = envSchema.parse(fromEnv(env))
  const optionsSchema = createConfigSchema(base, base.napcat, (path) => `插件选项 ${path}`, warn)
  const parsed: RawConfig = optionsSchema.parse(options)

  const url = parsed.napcat.url
  if (!url) {
    throw new Error(
      "未配置 NapCat WebSocket 地址：请设置环境变量 NAPCAT_WS_URL 或插件选项 napcat.url",
    )
  }

  for (const warning of warnings) onWarning(warning)
  return { ...parsed, napcat: { url, token: parsed.napcat.token } }
}
