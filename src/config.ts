import { createConfigSchema, EVENT_CATEGORIES, warnUnknownFileKeys } from "./config/registry"
import type { ConfigWarning } from "./config/registry"
import type { ParsedConfig, QQBotConfig } from "./config/types"

/**
 * 插件配置：唯一来源是机器人工作目录下的 `config.json`。
 *
 * 文件里没写的字段走默认值；`opencode.json` 里只有 `agent` 一项会被读，
 * 环境变量不再是配置来源。
 */

export type {
  AccessConfig,
  DiaryConfig,
  DiaryPush,
  EventsConfig,
  HistoryConfig,
  KeepAliveConfig,
  LogConfig,
  LogLevel,
  MediaConfig,
  ModelRef,
  NapcatConfig,
  PanelConfig,
  ParsedConfig,
  ProactiveConfig,
  QQBotConfig,
  RateLimitConfig,
  RawConfig,
  ReminderConfig,
  ReplyConfig,
  SensitiveConfig,
  TraceConfig,
  WakeConfig,
} from "./config/types"

export {
  CONFIG_FIELDS,
  CONFIG_GROUPS,
  type ConfigField,
  type ConfigGroup,
  type FieldType,
} from "./config/fields"

export {
  applyHotFields,
  configJsonSchema,
  createConfigSchema,
  createStrictFieldSchema,
  DEFAULT_CONFIG,
  FILE_KEYS,
  getConfigValue,
  HOT_FIELDS,
  isSecretField,
  parseModelRef,
  type ConfigWarning,
} from "./config/registry"

/** 只保留认识的事件类别：写错的类别直接告警，不静默失效。 */
function filterEventCategories(categories: readonly string[], warn: ConfigWarning): string[] {
  const subscribe: string[] = []
  for (const category of categories) {
    if (!EVENT_CATEGORIES.includes(category)) {
      warn(`events.subscribe 忽略未知类别：${category}`)
      continue
    }
    if (!subscribe.includes(category)) subscribe.push(category)
  }
  return subscribe
}

/**
 * 解析配置文件内容。
 *
 * 非法值告警并回退默认值，不让一个手写错的值让插件起不来；
 * 配置文件里不认识的键告警但保留在文件里，不静默丢弃。
 *
 * @param raw `config.json` 的原始内容。
 * @param agent `opencode.json` 里的 agent：OpenCode 侧的路由语义，不存在配置文件里。
 * @param onWarning 告警回调。
 * @throws 当没有配置 NapCat WebSocket 地址时抛出，避免带着无效凭证启动。
 */
export function resolveConfig(
  raw: Record<string, unknown>,
  agent?: string,
  onWarning: ConfigWarning = () => {},
): QQBotConfig {
  const warnings: string[] = []
  const warn: ConfigWarning = (message) => warnings.push(message)

  warnUnknownFileKeys(raw, warn)
  const schema = createConfigSchema(warn)
  const parsed: ParsedConfig = schema.parse(raw)

  const subscribe = filterEventCategories(parsed.events.subscribe, warn)

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
      "未配置 NapCat WebSocket 地址：请在 config.json 里填写 napcat.url（格式 ws://127.0.0.1:3001）",
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
    diary: {
      ...parsed.diary,
      summaryTargets: [...parsed.diary.summaryTargets],
    },
    panel: { ...parsed.panel },
    napcat: { url, token: parsed.napcat.token },
    ...(agent ? { agent } : {}),
  }
}
