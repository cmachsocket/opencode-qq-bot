/**
 * 配置对象的类型定义。
 *
 * 字段清单以 `src/config/fields.ts` 的注册表为准；这里的类型描述运行时
 * 解析后的形状，两边由一致性测试盯着。
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

/** 日记的推送方式。 */
export type DiaryPush = "owner" | "group" | "none"

/** 日记配置。 */
export interface DiaryConfig {
  /** 日记根目录；空表示用机器人工作目录下的 `diary` 子目录。 */
  path: string
  /** 是否启用日记功能。 */
  enabled: boolean
  /** 聊天素材保留天数；只影响素材，不影响日记成品。 */
  retentionDays: number
  /** 每天生成日记的时刻，格式 `HH:mm`，本地时间。 */
  summaryTime: string
  /** 调度轮询间隔（秒）。 */
  tickSeconds: number
  /** 要生成日记的聊天，`group:123` / `private:456`；空表示按准入名单推导。 */
  summaryTargets: string[]
  /** 日记生成后往哪儿推：`owner` 推给所有者，`group` 推回聊天，`none` 不推。 */
  push: DiaryPush
  /** 是否回补历史聊天记录。 */
  backfill: boolean
  /** 回补时最多取多少条历史消息。 */
  backfillMax: number
  /** 单条素材的最大字符数。 */
  maxLineChars: number
  /** 单个聊天单天最多保留多少条素材。 */
  maxLinesPerDay: number
  /** 等待模型总结的超时时间（毫秒）。 */
  timeoutMs: number
}

/** 状态面板配置。 */
export interface PanelConfig {
  /** 是否启用面板。 */
  enabled: boolean
  /** 监听地址。 */
  host: string
  /** 监听端口。 */
  port: number
  /** 访问令牌；留空时自动生成并写回配置文件。 */
  token: string
  /** 是否已吊销访问令牌：吊销后不再自动补令牌，面板也不再对外服务。 */
  tokenRevoked: boolean
}

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

/** 日志级别。 */
export type LogLevel = "debug" | "info" | "warn" | "error"

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
  /** 角色设定的边界：允许哪些目录里的文件能进提示词。 */
  soul: SoulConfig
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
  diary: DiaryConfig
  panel: PanelConfig
}

/** 角色设定的边界配置。 */
export interface SoulConfig {
  /**
   * 允许的角色设定根目录；相对路径按机器人工作目录解析。
   *
   * 默认只有工作目录：角色设定的内容会随每一轮发给模型服务商，
   * 越出允许根的文件不会被加载。
   */
  allowedPaths: string[]
}

/** 准入配置。 */
export interface AccessConfig {
  /** 放行名单。 */
  allow: { groups: number[]; users: number[] }
  /** 拒绝名单。 */
  deny: { groups: number[]; users: number[] }
  /** 放行名单为空时是否放行全部目标。 */
  allowAllWhenEmpty: boolean
}

/** 解析前的配置形状：文件里没写的字段都是空的。 */
export type RawConfig = Record<string, unknown>

/** zod 解析后的形状：没写的可选项是空的。 */
export type ParsedConfig = Omit<
  QQBotConfig,
  "napcat" | "ownerQQ" | "model" | "soulPath" | "soulName"
> & {
  /** NapCat 连接信息：地址必填但可能缺失，令牌可选。 */
  napcat: { url?: string; token?: string }
  ownerQQ?: number
  model?: ModelRef
  soulPath?: string
  soulName?: string
}
