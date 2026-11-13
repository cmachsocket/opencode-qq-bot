import type {
  ConfigResponse,
  DocumentResponse,
  DocumentSaveResponse,
  LogEntry,
  ModelInfo,
  SaveResponse,
  SchemaResponse,
  Status,
} from "./types"

/**
 * 与面板后端通信。
 *
 * 数据层只用平台原生的 `fetch` 与 `EventSource`：面板只是「读一次 + 轮询/SSE 刷新」，
 * 不需要请求库那一套缓存与失效策略。
 */

/** 接口报错：带上 HTTP 状态码与逐字段的原因，调用方据此标红出问题的字段。 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields: Array<{ path: string; message: string }> = [],
  ) {
    super(message)
    this.name = "ApiError"
  }
}

/** 发一次请求并解析 JSON。 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    let message = `请求失败（${response.status}）`
    let fields: Array<{ path: string; message: string }> = []
    try {
      const body = (await response.json()) as {
        message?: string
        fields?: Array<{ path: string; message: string }>
      }
      if (body.message) message = body.message
      if (Array.isArray(body.fields)) fields = body.fields
    } catch {
      // 响应不是 JSON：用状态码兜底。
    }
    throw new ApiError(response.status, message, fields)
  }
  return (await response.json()) as T
}

/** 面板接口。 */
export const api = {
  /** 用令牌换会话 Cookie。 */
  async login(token: string): Promise<void> {
    await request<{ ok: boolean }>("/api/login", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
  },
  /** 字段元数据与 JSON Schema。 */
  schema(): Promise<SchemaResponse> {
    return request<SchemaResponse>("/api/config/schema")
  },
  /** 生效值与来源。 */
  config(): Promise<ConfigResponse> {
    return request<ConfigResponse>("/api/config")
  },
  /** 提交稀疏补丁。 */
  save(patch: Record<string, unknown>): Promise<SaveResponse> {
    return request<SaveResponse>("/api/config", {
      method: "PUT",
      body: JSON.stringify(patch),
    })
  },
  /** 可用模型。 */
  models(): Promise<{ models: ModelInfo[] }> {
    return request<{ models: ModelInfo[] }>("/api/models")
  },
  /** 运行状态。 */
  status(): Promise<Status> {
    return request<Status>("/api/status")
  },
  /** 日志尾部。 */
  logs(options: { limit?: number; level?: string } = {}): Promise<{ entries: LogEntry[] }> {
    const query = new URLSearchParams()
    if (options.limit !== undefined) query.set("limit", String(options.limit))
    if (options.level) query.set("level", options.level)
    const suffix = query.toString()
    return request<{ entries: LogEntry[] }>(`/api/logs${suffix ? `?${suffix}` : ""}`)
  },
  /** 会话覆盖文件：生效值、文件值与告警。 */
  chatOverrides(): Promise<DocumentResponse> {
    return request<DocumentResponse>("/api/chat-overrides")
  },
  /** 保存会话覆盖：提交稀疏改动。 */
  saveChatOverrides(patch: Record<string, unknown>): Promise<DocumentSaveResponse> {
    return request<DocumentSaveResponse>("/api/chat-overrides", {
      method: "PUT",
      body: JSON.stringify(patch),
    })
  },
  /** 工具配置文件：生效值、文件值与告警。 */
  toolProfiles(): Promise<DocumentResponse> {
    return request<DocumentResponse>("/api/tool-profiles")
  },
  /** 保存工具配置：提交稀疏改动。 */
  saveToolProfiles(patch: Record<string, unknown>): Promise<DocumentSaveResponse> {
    return request<DocumentSaveResponse>("/api/tool-profiles", {
      method: "PUT",
      body: JSON.stringify(patch),
    })
  },
}

/** SSE 推送的事件。 */
export interface StreamHandlers {
  /** 状态快照。 */
  status?: (status: Status) => void
  /** 新日志。 */
  log?: (entry: LogEntry) => void
  /** 配置变化。 */
  config?: (config: ConfigResponse) => void
}

/**
 * 订阅 SSE。
 *
 * `EventSource` 自带断线重连，这里只补连接状态显示。
 *
 * @returns 关闭连接的函数。
 */
export function openStream(handlers: StreamHandlers): () => void {
  const source = new EventSource("/api/stream")
  const listen = (name: string, handler: ((payload: unknown) => void) | undefined) => {
    if (!handler) return
    source.addEventListener(name, (event) => {
      try {
        handler(JSON.parse((event as MessageEvent).data as string))
      } catch {
        // 推送的内容不是 JSON：忽略这一条。
      }
    })
  }
  listen("status", (payload) => handlers.status?.(payload as Status))
  listen("log", (payload) => handlers.log?.(payload as LogEntry))
  listen("config", (payload) => handlers.config?.(payload as ConfigResponse))
  return () => source.close()
}
