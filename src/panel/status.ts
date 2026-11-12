import { targetKey } from "../chat"
import { defaultLogDir } from "../logger"
import type { TraceSpan } from "../trace"
import type { PanelRuntime } from "./runtime"

/**
 * 运行状态快照。
 *
 * `/api/status` 与 SSE 推送共用这一份实现：面板看到的和命令输出看到的是同一套数据。
 */

/** 状态快照。 */
export interface StatusSnapshot {
  /** 插件版本。 */
  version: string
  /** 进程启动时间（毫秒）。 */
  startedAt: number
  /** 已经跑了多久（毫秒）。 */
  uptimeMs: number
  /** 运行时信息。 */
  runtime: {
    /** 机器人工作目录。 */
    home: string
    /** 日志目录。 */
    logDir: string
    /** `opencode.json` 里的 agent。 */
    agent?: string
    /** 配置里选的模型。 */
    model?: string
    /** 面板自身的监听信息。 */
    panel: { enabled: boolean; host: string; port: number }
  }
  /** 连接概览。 */
  connection: {
    /** NapCat 是否连着。 */
    connected: boolean
    /** 机器人的 QQ 号。 */
    selfId?: string
    /** 重连次数。 */
    reconnects: number
    /** 最后一次重连的时间（毫秒）。 */
    lastReconnectAt?: number
  }
  /** 各聊天的会话状态。 */
  sessions: Array<{
    /** 聊天目标键，例如 `group:123`。 */
    target: string
    /** 绑定的上游会话。 */
    sessionID?: string
    /** 当前是否有一轮在跑。 */
    busy: boolean
    /** 缓存中的消息条数。 */
    buffered: number
    /** 是否在等待重试。 */
    pending: boolean
    /** 唤醒方式，来自会话覆盖。 */
    wake?: string
    /** 是否允许主动说话。 */
    proactive?: boolean
  }>
  /** 出站限流用量。 */
  rateLimit: Array<{
    /** 计数维度，通常是目标键。 */
    scope: string
    /** 每分钟上限。 */
    maxPerMinute: number
    /** 每小时上限。 */
    maxPerHour: number
    /** 这一分钟已发多少条。 */
    usedPerMinute: number
    /** 这一小时已发多少条。 */
    usedPerHour: number
    /** 这一分钟还剩多少条。 */
    minuteLeft: number
    /** 这一小时还剩多少条。 */
    hourLeft: number
  }>
  /** 最近的调用链追踪节点。 */
  traces: TraceSpan[]
  /** 日记调度。 */
  diary: {
    /** 是否启用。 */
    enabled: boolean
    /** 每天几点生成总结。 */
    summaryTime: string
    /** 下次运行时间（毫秒）。 */
    nextRunAt?: number
    /** 上次运行时间（毫秒）。 */
    lastRunAt?: number
    /** 上次运行的结果。 */
    lastResult?: string
  }
  /** 工具策略。 */
  policy: {
    /** 默认配置档。 */
    defaultProfile: string
    /** 配置档名字。 */
    profiles: string[]
    /** 按聊天指定的配置档。 */
    chats: Record<string, string>
  }
}

/** 会话表的一行。 */
interface SessionRow {
  /** 聊天目标键，例如 `group:123`。 */
  target: string
  /** 绑定的上游会话。 */
  sessionID?: string
  /** 当前是否有一轮在跑。 */
  busy: boolean
  /** 缓存中的消息条数。 */
  buffered: number
  /** 是否在等待重试。 */
  pending: boolean
  /** 唤醒方式，来自会话覆盖。 */
  wake?: string
  /** 是否允许主动说话。 */
  proactive?: boolean
}

/**
 * 采集运行状态快照。
 *
 * @param runtime 运行时句柄；还没就绪的部分留空，不让面板因为缺一个模块就报错。
 */
export async function collectStatus(runtime: PanelRuntime): Promise<StatusSnapshot> {
  const config = runtime.config
  const sessions = await collectSessions(runtime)
  const policy = await runtime.policy?.current()
  const diary = runtime.diary
  return {
    version: runtime.version,
    startedAt: runtime.startedAt,
    uptimeMs: Date.now() - runtime.startedAt,
    runtime: {
      home: runtime.home.directory,
      logDir: config.log.dir.trim() || defaultLogDir(),
      ...(runtime.agent ? { agent: runtime.agent } : {}),
      ...(config.model
        ? {
            model: [config.model.providerID, config.model.id, config.model.variant]
              .filter(Boolean)
              .join("/"),
          }
        : {}),
      panel: {
        enabled: config.panel.enabled,
        host: config.panel.host,
        port: config.panel.port,
      },
    },
    connection: {
      connected: runtime.client?.connected ?? false,
      ...(runtime.client?.selfId ? { selfId: runtime.client.selfId } : {}),
      reconnects: runtime.client?.reconnects ?? 0,
      ...(runtime.client?.lastReconnectAt
        ? { lastReconnectAt: runtime.client.lastReconnectAt }
        : {}),
    },
    sessions,
    rateLimit: runtime.limiter?.snapshot() ?? [],
    traces: runtime.tracer?.spans().slice(-50) ?? [],
    diary: {
      enabled: config.diary.enabled,
      summaryTime: config.diary.summaryTime,
      ...(diary?.nextRunAt() !== undefined ? { nextRunAt: diary.nextRunAt() } : {}),
      ...(diary?.lastRunAt() !== undefined ? { lastRunAt: diary.lastRunAt() } : {}),
      ...(diary?.lastResult() ? { lastResult: diary.lastResult() } : {}),
    },
    policy: {
      defaultProfile: policy?.defaultProfile ?? "chat",
      profiles: policy ? Object.keys(policy.profiles) : [],
      chats: policy?.chats ?? {},
    },
  }
}

/** 会话表：会话状态加上会话覆盖里的唤醒方式。 */
async function collectSessions(runtime: PanelRuntime): Promise<SessionRow[]> {
  const manager = runtime.manager
  if (!manager) return []
  const items = manager.snapshot()
  const result: SessionRow[] = []
  for (const item of items) {
    const override = await runtime.overrides?.for(item.target)
    result.push({
      target: targetKey(item.target),
      ...(item.sessionID ? { sessionID: item.sessionID } : {}),
      busy: item.busy,
      buffered: item.buffered,
      pending: item.pending,
      ...(override?.wake ? { wake: override.wake } : {}),
      ...(override?.proactive !== undefined ? { proactive: override.proactive } : {}),
    })
  }
  return result
}
