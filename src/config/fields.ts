/**
 * 配置项注册表：全局配置的唯一事实源。
 *
 * 每个配置项在这里声明一次，别的模块（默认值、zod 校验、配置文件键集合、
 * JSON Schema、面板表单）都由它生成，不再各写一份。
 */

/** 配置项的值类型，决定前端渲染成哪种控件。 */
export type FieldType =
  | "boolean"
  | "number"
  | "text"
  | "secret"
  | "enum"
  | "numberList"
  | "stringList"
  | "clock"
  | "modelRef"
  | "path"

/** 单个配置项的元数据。 */
export interface ConfigField {
  /** 配置路径，例如 `rateLimit.maxPerMinute`。 */
  path: string
  /** 所属分组，用于表单导航。 */
  group: string
  /** 值的类型，决定前端渲染成哪种控件。 */
  type: FieldType
  /** 中文标签。 */
  label: string
  /** 补充说明。 */
  description?: string
  /** 默认值；`undefined` 表示可以不配置。 */
  default: unknown
  /** 数值下限。 */
  min?: number
  /** 数值上限。 */
  max?: number
  /** 数值步长；`1` 表示只接受整数。 */
  step?: number
  /** 枚举候选值。 */
  options?: readonly string[]
  /** 是否属于敏感字段：不回显、掩码显示。 */
  secret?: boolean
  /** 是否必填：必填项不能删掉，删了配置就装不起来。 */
  required?: boolean
  /** 保存后是否可以立即生效，不必重启。 */
  hot?: boolean
  /** 下限是否取不到：`min` 变成排他下界。 */
  exclusiveMin?: boolean
}

/** 配置分组：表单左侧导航。 */
export interface ConfigGroup {
  /** 分组 id，与 `ConfigField.group` 对应。 */
  id: string
  /** 分组名称。 */
  label: string
}

/** 分组顺序与名称。 */
export const CONFIG_GROUPS: readonly ConfigGroup[] = [
  { id: "general", label: "基础" },
  { id: "napcat", label: "NapCat 连接" },
  { id: "access", label: "准入" },
  { id: "proactive", label: "主动说话" },
  { id: "wake", label: "唤醒" },
  { id: "reply", label: "回复" },
  { id: "rateLimit", label: "出站限流" },
  { id: "sensitive", label: "敏感拦截" },
  { id: "events", label: "事件订阅" },
  { id: "reminder", label: "补发提醒" },
  { id: "history", label: "历史补齐" },
  { id: "keepAlive", label: "保活" },
  { id: "trace", label: "调用链追踪" },
  { id: "log", label: "日志" },
  { id: "media", label: "出站媒体" },
  { id: "diary", label: "日记" },
  { id: "panel", label: "状态面板" },
]

/** 全部配置项。 */
export const CONFIG_FIELDS: readonly ConfigField[] = [
  // 基础
  {
    path: "ownerQQ",
    group: "general",
    type: "number",
    label: "所有者 QQ 号",
    description: "管理命令只在它的私聊生效；该私聊始终放行",
    default: undefined,
    min: 1,
    step: 1,
    hot: true,
  },
  {
    path: "admins",
    group: "general",
    type: "numberList",
    label: "管理员 QQ 号",
    description: "拥有全部工具权限；私聊还需在放行名单里",
    default: [],
    hot: true,
  },
  {
    path: "model",
    group: "general",
    type: "modelRef",
    label: "会话使用的模型",
    description: "格式 provider/model[/variant]；留空跟随 OpenCode 的默认模型",
    default: undefined,
  },
  {
    path: "sendDelayMs",
    group: "general",
    type: "number",
    label: "分段发送间隔（毫秒）",
    description: "超长消息拆成多段时每段之间的固定间隔",
    default: 1000,
    min: 0,
  },
  {
    path: "warnLength",
    group: "general",
    type: "number",
    label: "长度告警阈值",
    description: "单次发送的内容超过该字数时告警，不截断",
    default: 500,
    min: 1,
    step: 1,
    hot: true,
  },
  {
    path: "reuseSession",
    group: "general",
    type: "boolean",
    label: "复用上一次的会话",
    description: "完全没有绑定时，按会话标记找回上一次的会话",
    default: false,
    hot: true,
  },
  {
    path: "toolProfilesPath",
    group: "general",
    type: "path",
    label: "工具配置文件路径",
    description: "空表示工作目录里的 tool-profiles.json；相对路径按工作目录解析",
    default: "",
  },
  {
    path: "chatOverridesPath",
    group: "general",
    type: "path",
    label: "会话覆盖文件路径",
    description: "空表示工作目录里的 chat-overrides.json；相对路径按工作目录解析",
    default: "",
  },
  {
    path: "soulPath",
    group: "general",
    type: "path",
    label: "角色设定路径",
    description: "留空表示工作目录里的 souls/",
    default: undefined,
  },
  {
    path: "soulName",
    group: "general",
    type: "text",
    label: "角色设定文件名",
    description: "工作目录 souls 里的角色设定文件名",
    default: undefined,
  },

  // NapCat
  {
    path: "napcat.url",
    group: "napcat",
    type: "text",
    label: "NapCat WebSocket 地址",
    description: "正向 WebSocket 地址，必填",
    default: undefined,
    required: true,
  },
  {
    path: "napcat.token",
    group: "napcat",
    type: "secret",
    label: "NapCat 访问令牌",
    description: "NapCat 的访问令牌，留空表示不校验",
    default: undefined,
    secret: true,
  },

  // 准入
  {
    path: "access.allow.groups",
    group: "access",
    type: "numberList",
    label: "放行的群号",
    description: "为空时不响应任何群消息（除非打开 allowAllWhenEmpty）",
    default: [],
    hot: true,
  },
  {
    path: "access.allow.users",
    group: "access",
    type: "numberList",
    label: "放行的私聊 QQ 号",
    description: "为空时不响应任何私聊（除非打开 allowAllWhenEmpty）",
    default: [],
    hot: true,
  },
  {
    path: "access.deny.groups",
    group: "access",
    type: "numberList",
    label: "拒绝的群号",
    description: "优先于放行名单",
    default: [],
    hot: true,
  },
  {
    path: "access.deny.users",
    group: "access",
    type: "numberList",
    label: "拒绝的私聊 QQ 号",
    description: "优先于放行名单；owner 的私聊会被豁免",
    default: [],
    hot: true,
  },
  {
    path: "access.allowAllWhenEmpty",
    group: "access",
    type: "boolean",
    label: "放行名单为空时放行全部",
    description: "打开后任何群聊与私聊都能触发机器人",
    default: false,
    hot: true,
  },

  // 主动说话
  {
    path: "proactive.enabled",
    group: "proactive",
    type: "boolean",
    label: "启用主动说话",
    description: "沉默达到阈值后由机器人主动发起话题",
    default: true,
  },
  {
    path: "proactive.silenceThresholdSeconds",
    group: "proactive",
    type: "number",
    label: "沉默阈值（秒）",
    description: "群沉默多久后才开始计算主动说话概率",
    default: 10800,
    min: 0,
  },
  {
    path: "proactive.startProbability",
    group: "proactive",
    type: "number",
    label: "起始概率",
    description: "刚跨过阈值时的单次触发概率",
    default: 0.01,
    min: 0,
    max: 1,
  },
  {
    path: "proactive.probabilityPerHour",
    group: "proactive",
    type: "number",
    label: "每小时概率增量",
    description: "每多沉默一小时概率增加多少",
    default: 0.05,
    min: 0,
    max: 1,
  },
  {
    path: "proactive.tickSeconds",
    group: "proactive",
    type: "number",
    label: "心跳间隔（秒）",
    description: "主动说话心跳的轮询间隔，必须大于 0",
    default: 3600,
    min: 0,
    exclusiveMin: true,
  },
  {
    path: "proactive.allowGroups",
    group: "proactive",
    type: "numberList",
    label: "主动说话的群号",
    description: "留空表示一个都不主动说话",
    default: [],
  },
  {
    path: "proactive.allowUsers",
    group: "proactive",
    type: "numberList",
    label: "主动说话的私聊 QQ 号",
    description: "留空表示一个都不主动说话",
    default: [],
  },

  // 唤醒
  {
    path: "wake.prefixes",
    group: "wake",
    type: "stringList",
    label: "全局唤醒前缀",
    description: "消息以这些前缀开头就必须回复",
    default: ["/"],
    hot: true,
  },
  {
    path: "wake.ignoreAtAll",
    group: "wake",
    type: "boolean",
    label: "忽略 @全体成员",
    description: "群里 @ 全体成员时不唤醒机器人",
    default: true,
    hot: true,
  },
  {
    path: "wake.replyToSelf",
    group: "wake",
    type: "boolean",
    label: "回复机器人自己也要回",
    description: "回复了机器人自己的消息时必须回复",
    default: true,
    hot: true,
  },
  {
    path: "wake.ignoreAtOthers",
    group: "wake",
    type: "boolean",
    label: "忽略 @他人",
    description: "群里第一个 @ 指向别人时不唤醒机器人",
    default: true,
    hot: true,
  },

  // 回复
  {
    path: "reply.minDelayMs",
    group: "reply",
    type: "number",
    label: "分段延迟下限（毫秒）",
    description: "分段之间随机等待的下限",
    default: 0,
    min: 0,
    hot: true,
  },
  {
    path: "reply.maxDelayMs",
    group: "reply",
    type: "number",
    label: "分段延迟上限（毫秒）",
    description: "分段之间随机等待的上限，0 表示用固定间隔",
    default: 0,
    min: 0,
    hot: true,
  },
  {
    path: "reply.segmentChars",
    group: "reply",
    type: "number",
    label: "单段字数上限",
    description: "单条消息超过该字数就拆成多段发送",
    default: 150,
    min: 1,
    step: 1,
    hot: true,
  },
  {
    path: "reply.forwardThresholdChars",
    group: "reply",
    type: "number",
    label: "合并转发阈值",
    description: "单条回复超过该字数就改用合并转发，0 表示关闭",
    default: 1500,
    min: 0,
    hot: true,
  },
  {
    path: "reply.requirePermission",
    group: "reply",
    type: "boolean",
    label: "回复前先说明理由",
    description: "群里发消息前模型要先说明为什么要回复",
    default: true,
    hot: true,
  },

  // 出站限流
  {
    path: "rateLimit.maxPerMinute",
    group: "rateLimit",
    type: "number",
    label: "每分钟最多发多少条",
    description: "0 表示不限制",
    default: 8,
    min: 0,
    hot: true,
  },
  {
    path: "rateLimit.maxPerHour",
    group: "rateLimit",
    type: "number",
    label: "每小时最多发多少条",
    description: "0 表示不限制",
    default: 60,
    min: 0,
    hot: true,
  },
  {
    path: "rateLimit.minGapMs",
    group: "rateLimit",
    type: "number",
    label: "发送最小间隔（毫秒）",
    description: "相邻两次发送之间的最小间隔，0 表示不限制",
    default: 1500,
    min: 0,
    hot: true,
  },
  {
    path: "rateLimit.stall",
    group: "rateLimit",
    type: "boolean",
    label: "触顶后等窗口结束",
    description: "打开后等窗口结束再发，而不是直接拒绝",
    default: false,
    hot: true,
  },
  {
    path: "rateLimit.stallMaxWaitMs",
    group: "rateLimit",
    type: "number",
    label: "最多等多久（毫秒）",
    description: "等待窗口结束的上限，超过就直接拒绝",
    default: 60000,
    min: 0,
    hot: true,
  },

  // 敏感拦截
  {
    path: "sensitive.enabled",
    group: "sensitive",
    type: "boolean",
    label: "拦截敏感出站消息",
    description: "命中凭证的出站消息整条拦下，不发送",
    default: true,
    hot: true,
  },

  // 事件订阅
  {
    path: "events.subscribe",
    group: "events",
    type: "stringList",
    label: "订阅的事件类别",
    description: "message / notice，写错的类别会被忽略并告警",
    default: ["message"],
    hot: true,
  },
  {
    path: "events.notices",
    group: "events",
    type: "stringList",
    label: "关心的通知",
    description: "留空表示这类通知全收",
    default: [],
    hot: true,
  },
  {
    path: "events.inject",
    group: "events",
    type: "boolean",
    label: "通知注入会话上下文",
    description: "通知以附带信息出现在下一轮上下文里",
    default: true,
    hot: true,
  },

  // 补发提醒
  {
    path: "reminder.enabled",
    group: "reminder",
    type: "boolean",
    label: "提醒模型补发",
    description: "模型一轮没调用发送工具时提醒它补一次",
    default: true,
    hot: true,
  },
  {
    path: "reminder.max",
    group: "reminder",
    type: "number",
    label: "连续提醒次数上限",
    description: "避免模型陷入补发循环",
    default: 2,
    min: 0,
    step: 1,
    hot: true,
  },

  // 历史补齐
  {
    path: "history.count",
    group: "history",
    type: "number",
    label: "补齐多少条历史",
    description: "新建会话时补齐的历史消息条数，0 表示关闭",
    default: 20,
    min: 0,
    hot: true,
  },

  // 保活
  {
    path: "keepAlive.enabled",
    group: "keepAlive",
    type: "boolean",
    label: "启用保活心跳",
    description: "周期性写回会话元数据，避免被 OpenCode 空闲卸载",
    default: true,
  },
  {
    path: "keepAlive.seconds",
    group: "keepAlive",
    type: "number",
    label: "保活间隔（秒）",
    description: "必须小于 OpenCode 的 location 空闲超时",
    default: 1200,
    min: 0,
    exclusiveMin: true,
  },

  // 调用链追踪
  {
    path: "trace.enabled",
    group: "trace",
    type: "boolean",
    label: "记录调用链追踪",
    description: "一条入站消息的完整处理链",
    default: true,
  },
  {
    path: "trace.dir",
    group: "trace",
    type: "path",
    label: "追踪文件目录",
    description: "留空表示与日志同目录",
    default: "",
  },
  {
    path: "trace.maxSizeMb",
    group: "trace",
    type: "number",
    label: "追踪容量上限（MB）",
    description: "追踪文件总容量上限",
    default: 80,
    min: 0,
    exclusiveMin: true,
  },
  {
    path: "trace.retentionDays",
    group: "trace",
    type: "number",
    label: "追踪保留天数",
    description: "超过保留天数的追踪文件会被删除",
    default: 7,
    min: 1,
    step: 1,
  },

  // 日志
  {
    path: "log.level",
    group: "log",
    type: "enum",
    label: "日志级别",
    description: "debug / info / warn / error",
    default: "info",
    options: ["debug", "info", "warn", "error"],
    hot: true,
  },
  {
    path: "log.dir",
    group: "log",
    type: "path",
    label: "日志目录",
    description: "留空表示用 XDG 状态目录",
    default: "",
  },
  {
    path: "log.maxSize",
    group: "log",
    type: "text",
    label: "单个日志文件大小上限",
    description: "winston 的文件大小写法，例如 5m",
    default: "5m",
  },
  {
    path: "log.maxFiles",
    group: "log",
    type: "number",
    label: "保留历史日志份数",
    description: "按天轮转后最多保留多少份",
    default: 5,
    min: 1,
    step: 1,
  },

  // 出站媒体
  {
    path: "media.allowedDirs",
    group: "media",
    type: "stringList",
    label: "额外允许的媒体目录",
    description: "除工作目录与媒体目录外，额外放开可发送媒体的目录",
    default: [],
  },

  // 日记
  {
    path: "diary.path",
    group: "diary",
    type: "path",
    label: "日记目录",
    description: "留空表示工作目录下的 diary/；相对路径按工作目录解析",
    default: "",
  },
  {
    path: "diary.enabled",
    group: "diary",
    type: "boolean",
    label: "启用日记",
    description: "把聊天流水记成 Markdown 文件",
    default: true,
  },
  {
    path: "diary.retentionDays",
    group: "diary",
    type: "number",
    label: "素材保留天数",
    description: "只清素材，不清日记成品",
    default: 30,
    min: 1,
    step: 1,
  },
  {
    path: "diary.summaryTime",
    group: "diary",
    type: "clock",
    label: "每天几点生成总结",
    description: "本地时间 HH:mm",
    default: "23:30",
  },
  {
    path: "diary.tickSeconds",
    group: "diary",
    type: "number",
    label: "调度间隔（秒）",
    description: "日记调度的轮询间隔",
    default: 3600,
    min: 0,
    exclusiveMin: true,
  },
  {
    path: "diary.summaryTargets",
    group: "diary",
    type: "stringList",
    label: "生成总结的聊天",
    description: "group:123 / private:456；留空表示按准入名单推导",
    default: [],
  },
  {
    path: "diary.push",
    group: "diary",
    type: "enum",
    label: "日记推送给谁",
    description: "owner 推给所有者，group 推回聊天，none 不推",
    default: "owner",
    options: ["owner", "group", "none"],
  },
  {
    path: "diary.backfill",
    group: "diary",
    type: "boolean",
    label: "回补历史聊天",
    description: "用 NapCat 的历史消息回补素材",
    default: false,
  },
  {
    path: "diary.backfillMax",
    group: "diary",
    type: "number",
    label: "回补最多取多少条",
    description: "回补时最多取多少条历史消息",
    default: 1000,
    min: 0,
    exclusiveMin: true,
  },
  {
    path: "diary.maxLineChars",
    group: "diary",
    type: "number",
    label: "单条素材字数上限",
    description: "单条素材的最大字符数",
    default: 200,
    min: 0,
    exclusiveMin: true,
  },
  {
    path: "diary.maxLinesPerDay",
    group: "diary",
    type: "number",
    label: "每天最多保留多少条素材",
    description: "单个聊天单天的素材条数上限",
    default: 2000,
    min: 0,
    exclusiveMin: true,
  },
  {
    path: "diary.timeoutMs",
    group: "diary",
    type: "number",
    label: "总结超时（毫秒）",
    description: "等待模型生成总结的超时时间",
    default: 120000,
    min: 0,
    exclusiveMin: true,
  },

  // 状态面板
  {
    path: "panel.enabled",
    group: "panel",
    type: "boolean",
    label: "启用状态面板",
    description: "面板自带 HTTP 服务，默认开启",
    default: true,
    hot: true,
  },
  {
    path: "panel.host",
    group: "panel",
    type: "text",
    label: "监听地址",
    description: "默认只监听本机",
    default: "127.0.0.1",
    hot: true,
  },
  {
    path: "panel.port",
    group: "panel",
    type: "number",
    label: "监听端口",
    description: "面板 HTTP 服务的端口",
    default: 7391,
    min: 1,
    max: 65535,
    step: 1,
    hot: true,
  },
  {
    path: "panel.token",
    group: "panel",
    type: "secret",
    label: "访问令牌",
    description: "留空时自动生成并写回配置文件",
    default: "",
    secret: true,
    hot: true,
  },
]
