/** 面板前端与服务端共用的数据结构。 */

/** 配置项的值类型。 */
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
export interface FieldMeta {
  /** 配置路径。 */
  path: string
  /** 所属分组。 */
  group: string
  /** 值的类型。 */
  type: FieldType
  /** 中文标签。 */
  label: string
  /** 补充说明。 */
  description?: string
  /** 默认值。 */
  default?: unknown
  /** 数值下限。 */
  min?: number
  /** 数值上限。 */
  max?: number
  /** 数值步长。 */
  step?: number
  /** 枚举候选值。 */
  options?: string[]
  /** 是否敏感字段。 */
  secret?: boolean
  /** 是否热更新。 */
  hot?: boolean
}

/** 配置分组。 */
export interface GroupMeta {
  /** 分组 id。 */
  id: string
  /** 分组名称。 */
  label: string
}

/** `/api/config/schema` 的返回。 */
export interface SchemaResponse {
  /** 结构版本。 */
  version: number
  /** 分组列表。 */
  groups: GroupMeta[]
  /** 字段元数据。 */
  fields: FieldMeta[]
  /** JSON Schema：与字段注册表同源，供外部客户端校验。 */
  jsonSchema: Record<string, unknown>
}

/** 配置项的生效值视图。 */
export interface FieldView {
  /** 配置路径。 */
  path: string
  /** 生效值；敏感字段没有这一项。 */
  value?: unknown
  /** 文件里写的值；敏感字段没有这一项。 */
  fileValue?: unknown
  /** 值来自哪里。 */
  source: "file" | "default"
  /** 是否敏感字段。 */
  secret: boolean
  /** 是否热更新。 */
  hot: boolean
  /** 敏感字段只给这个：有没有值。 */
  hasValue?: boolean
}

/** `/api/config` 的返回。 */
export interface ConfigResponse {
  /** 每个字段的生效值。 */
  fields: FieldView[]
}

/** `PUT /api/config` 的返回。 */
export interface SaveResponse {
  /** 是否保存成功。 */
  ok: boolean
  /** 需要重启才能生效的字段。 */
  restartRequired: string[]
  /** 保存后的生效值。 */
  fields: FieldView[]
}

/** 可用模型。 */
export interface ModelInfo {
  /** provider id。 */
  providerID: string
  /** 模型 id。 */
  id: string
  /** 展示名。 */
  name: string
  /** 是否是默认模型。 */
  default: boolean
}

/** 日志条目。 */
export interface LogEntry {
  /** 时间。 */
  time: string
  /** 级别。 */
  level: "debug" | "info" | "warn" | "error"
  /** 正文。 */
  message: string
  /** 附加信息。 */
  meta: unknown[]
}

/** 追踪节点。 */
export interface TraceSpan {
  /** 追踪 id。 */
  traceId: string
  /** 节点 id。 */
  spanId: string
  /** 节点名。 */
  name: string
  /** 发生时间（毫秒）。 */
  at: number
  /** 聊天目标。 */
  target?: string
  /** 附加信息。 */
  attributes?: Record<string, unknown>
}

/** 运行状态快照。 */
export interface Status {
  /** 插件版本。 */
  version: string
  /** 启动时间（毫秒）。 */
  startedAt: number
  /** 已经跑了多久（毫秒）。 */
  uptimeMs: number
  /** 运行时信息。 */
  runtime: {
    home: string
    logDir: string
    agent?: string
    model?: string
    panel: { enabled: boolean; host: string; port: number }
  }
  /** 连接概览。 */
  connection: {
    connected: boolean
    selfId?: string
    reconnects: number
    lastReconnectAt?: number
  }
  /** 会话表。 */
  sessions: Array<{
    target: string
    sessionID?: string
    busy: boolean
    buffered: number
    pending: boolean
    wake?: string
    proactive?: boolean
  }>
  /** 限流用量。 */
  rateLimit: Array<{
    scope: string
    maxPerMinute: number
    maxPerHour: number
    usedPerMinute: number
    usedPerHour: number
    minuteLeft: number | null
    hourLeft: number | null
  }>
  /** 追踪节点。 */
  traces: TraceSpan[]
  /** 日记调度。 */
  diary: {
    enabled: boolean
    summaryTime: string
    nextRunAt?: number
    lastRunAt?: number
    nextSummaryAt?: number
    lastResult?: string
  }
  /** 工具策略。 */
  policy: {
    defaultProfile: string
    profiles: string[]
    chats: Record<string, string>
  }
}
