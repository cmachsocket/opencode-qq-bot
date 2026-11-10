import type { Plugin } from "@opencode/plugin"
import type { Location } from "@opencode/schema"
import { SessionMessage } from "@opencode/schema"
import { Mutex } from "async-mutex"
import { isTargetAllowed } from "../access"
import { unrefTimer } from "../async"
import { type ChatTarget, parseTargetKey, targetKey, targetLabel } from "../chat"
import type { ModelRef, QQBotConfig } from "../config"
import type { BotHome } from "../home"
import type { Logger } from "../logger"
import type { HistoryPosition, HistoryProvider } from "../naplink/history"
import type { ChatOverrides } from "../overrides"
import type { Tracer } from "../trace"
import { limitFiles, type PromptFile } from "../naplink/render"
import type { WakeReason } from "../overrides"
import { roleForChat, roleOf, type Role } from "../tools/policy"
import { findSession } from "./find"

/** 插件存储里保存会话与目标绑定的键。 */
const BINDINGS_KEY = "bindings"
/** 插件存储里保存目标最近活跃时间的键。 */
const ACTIVITY_KEY = "activity"
/** 插件存储里保存每个目标已投递到的消息位置的键。 */
const POSITIONS_KEY = "positions"
/** 插件存储里保存重启前仍在执行的轮次的键。 */
const INFLIGHT_KEY = "inflight"
/** 单个目标最多缓存的消息条数。 */
export const MAX_BUFFER_TURNS = 100
/** 单个目标最多缓存的文本与附件字节数。 */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024
/** 每个目标最多记录的消息 ID 数量。 */
const MAX_TRACKED_MESSAGES = 200
/** 刚投递的一轮还没在上游体现出忙碌状态，先跳过对账避免重复投递。 */
export const SUBMIT_GRACE_MS = 5_000
/** 失败批次最多重试几次；超过次数就丢弃，避免一个目标被永久堵死。 */
export const PENDING_MAX_ATTEMPTS = 3
/** 缓存里还有消息时的兜底轮询间隔：上游结束事件丢了也能把消息放出去。 */
export const RESUME_INTERVAL_MS = 30_000
/** 回合失败且模型一句话都没发出时，补到聊天里的固定文案。 */
export const FAILURE_NOTICE = "⚠️ 暂时无法处理这条消息，请稍后再试。"
/** 回合被中断时的固定文案。 */
export const INTERRUPTED_NOTICE = "⏹️ 已停止"
/** 同一目标两次失败提示的最小间隔，连续失败不会刷屏。 */
export const FAILURE_NOTICE_INTERVAL_MS = 5 * 60 * 1000
/** 退役会话后的冷却时间：这段时间内不再重建，避免上游整体故障时反复重建会话。 */
export const SESSION_RETIRE_COOLDOWN_MS = 10 * 60 * 1000
/** 交接时等在途投递落地的最长时间（毫秒）。 */
const HANDOVER_WAIT_MS = 3_000

/** 插件自己往聊天里补话的通道，失败兜底用。 */
export type FailureNotifier = (target: ChatTarget, text: string) => Promise<void>
function toMillis(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime()
  if (typeof value === "number") return value
  return undefined
}

/** 存储里的角色是否合法。 */
function isRole(value: unknown): value is Role {
  return value === "owner" || value === "admin" || value === "member" || value === "proactive"
}

/** 存储里的唤醒原因是否合法。 */
function isWakeReason(value: unknown): value is WakeReason {
  return (
    value === "private" ||
    value === "all" ||
    value === "mention" ||
    value === "prefix" ||
    value === "at_all" ||
    value === "reply"
  )
}

/** 解析存储里的在途轮次，格式不对时忽略。 */
function parseInflight(value: unknown): InflightTurn | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const numbers = [record.reminders, record.lastDispatchAt, record.idleAt, record.at]
  if (typeof record.sessionID !== "string" || record.sessionID.length === 0) return undefined
  if (typeof record.atMe !== "boolean" || typeof record.awaitingSend !== "boolean") return undefined
  if (!numbers.every((entry) => typeof entry === "number" && Number.isFinite(entry)))
    return undefined
  return {
    sessionID: record.sessionID,
    ...(isRole(record.role) ? { role: record.role } : {}),
    ...(typeof record.senderId === "string" ? { senderId: record.senderId } : {}),
    atMe: record.atMe,
    ...(isWakeReason(record.wake) ? { wake: record.wake } : {}),
    ...(record.suppress === true ? { suppress: true } : {}),
    ...(record.proactive === true ? { proactive: true } : {}),
    ...(typeof record.traceId === "string" ? { traceId: record.traceId } : {}),
    awaitingSend: record.awaitingSend,
    reminders: record.reminders as number,
    lastDispatchAt: record.lastDispatchAt as number,
    idleAt: record.idleAt as number,
    at: record.at as number,
  }
}

/** 解析存储里的消息位置，格式不对时忽略。 */
function parsePosition(value: unknown): HistoryPosition | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as { id?: unknown; time?: unknown }
  if (typeof record.id !== "string" || record.id.length === 0) return undefined
  if (typeof record.time !== "number" || !Number.isFinite(record.time)) return undefined
  return { id: record.id, time: record.time }
}

/** 上游会话是否仍在执行；依据 `time.busy` 是否晚于 `time.idle`。 */
function upstreamRunning(time: unknown): boolean {
  if (!time || typeof time !== "object") return false
  const { busy, idle } = time as { busy?: unknown; idle?: unknown }
  const busyAt = toMillis(busy)
  if (busyAt === undefined) return false
  const idleAt = toMillis(idle)
  return idleAt === undefined || busyAt > idleAt
}
export interface Turn {
  /** 投递幂等键；重试时保持不变，避免上游重复执行同一轮。 */
  id?: string
  /** 交给模型的文本。 */
  text: string
  /** 图片附件。 */
  files: PromptFile[]
  /** 本轮是否必须回复：私聊、被 @ 或命中唤醒条件时为 true。 */
  atMe: boolean
  /** 触发必回的原因，缺省按被 @ 处理。 */
  wake?: WakeReason
  /** 是否由主动说话心跳发起。 */
  proactive?: boolean
  /** 本轮最后一条 QQ 消息的位置，用来记录已经投递到哪里。 */
  source?: HistoryPosition
  /** 发送者角色；决定这一轮能用哪些工具，缺省按普通成员处理。 */
  role?: Role
  /** 发送者 QQ 号；角色缺失时据此还原，群聊也能确定是谁在说话。 */
  senderId?: string
  /** 调用链追踪 id，用来把这一轮的各个节点串起来。 */
  traceId?: string
  /** 这条消息明确不是在跟机器人说话，不要插话。 */
  suppress?: boolean
}

interface ChatState {
  target: ChatTarget
  /** 最近一轮的发送者角色；轮次结束后保留，供工具策略继续使用。 */
  role: Role
  sessionID?: string
  /** 等上游空闲后要投递的消息。 */
  buffer: Turn[]
  /** 已经尝试投递但失败的一批：内容与 id 冻结，重试时原样重发。 */
  pending?: Turn
  /** 当前失败批次已经重试的次数；超过上限就丢弃这批。 */
  pendingAttempts: number
  /** 最近一次投递的时间戳（毫秒）。 */
  lastDispatchAt: number
  /** 最近一次上游确认空闲的时间戳（毫秒）。 */
  idleAt: number
  /** 当前轮次的消息，供系统提示注入 @ 提示。 */
  current?: Turn
  /** 当前轮次模型是否还没调用发送工具。 */
  awaitingSend: boolean
  /** 连续提醒次数，防止死循环。 */
  reminders: number
  /** 最近一次真实用户消息的时间戳（毫秒）。 */
  lastUserMessageAt: number
  /** 本次运行是否已经为该目标补过历史。 */
  historyDone?: boolean
  /** 会话是否是在本次运行中新建的。 */
  sessionCreated?: boolean
  /** 最近一次自动退役会话的时间戳（毫秒）。 */
  lastRetireAt: number
  /** 最近一次清空当前轮次的原因与时间，仅供排查。 */
  lastClear?: { reason: string; at: number; role?: Role; traceId?: string }
  /** 本轮是否已批准发送：模型先说明理由才拿到这个权限，轮次结束即失效。 */
  replyAllowed: boolean
  /** 批准发送的理由，仅供日志与排查。 */
  replyReason?: string
}

/** 插件存储接受的值类型。 */
type StoredJson = Parameters<Plugin.Context["storage"]["set"]>[1]

/** 重启前仍在执行的轮次：只留判定工具权限需要的字段，不保存正文与附件。 */
interface InflightTurn {
  sessionID: string
  role?: Role
  /** 发送者 QQ 号；角色丢失时据此还原。 */
  senderId?: string
  atMe: boolean
  wake?: WakeReason
  suppress?: boolean
  proactive?: boolean
  traceId?: string
  awaitingSend: boolean
  reminders: number
  lastDispatchAt: number
  idleAt: number
  at: number
}

/** 实例交接时移交的会话状态。 */
export interface HandoverState {
  /** 这个聊天对应的目标。 */
  target: ChatTarget
  /** 绑定的上游会话。 */
  sessionID?: string
  /** 正在执行的一轮；为空表示上游已经空闲。 */
  current?: Turn
  /** 当前轮次模型是否还没调用发送工具。 */
  awaitingSend: boolean
  /** 连续提醒次数，防止死循环。 */
  reminders: number
  /** 最近一次投递的时间戳（毫秒）。 */
  lastDispatchAt: number
  /** 最近一次上游确认空闲的时间戳（毫秒）。 */
  idleAt: number
  /** 上游还在跑时排队的消息。 */
  buffer: Turn[]
  /** 已经尝试投递但失败的一批。 */
  pending?: Turn
  /** 当前失败批次已经重试的次数。 */
  pendingAttempts: number
}

/** 角色权限高低：数字越小权限越低。 */
const ROLE_RANK: Record<Role, number> = {
  proactive: 0,
  member: 1,
  admin: 2,
  owner: 3,
}

export function mergeTurns(turns: readonly Turn[]): Turn {
  // 同一条消息重复投递时只留一份。
  const seen = new Set<string>()
  const unique = turns.filter((turn) => {
    if (!turn.source) return true
    if (seen.has(turn.source.id)) return false
    seen.add(turn.source.id)
    return true
  })
  // 必回原因跟着真正要求回复的那条消息走。
  const wake = unique.find((turn) => turn.atMe && turn.wake)?.wake
  // 追踪 id 跟着这批消息里的第一条走。
  const traceId = unique.find((turn) => turn.traceId)?.traceId
  // 只要有一条要求必回，整批都要回；否则只要有消息不是在跟机器人说话，就不要插话。
  const atMe = unique.some((turn) => turn.atMe)
  const suppress = !atMe && unique.some((turn) => turn.suppress)
  // 批次的位置取最后一条带位置的消息。
  const source = unique.reduce<HistoryPosition | undefined>(
    (latest, turn) => turn.source ?? latest,
    undefined,
  )
  // 一批消息可能来自不同的人：按最低权限执行，避免普通成员的话借到管理员的工具。
  // 主动说话没有人参与，它带进来的上下文同样不可信，权限比普通成员还低。
  // 没有携带角色的轮次不参与比较：调用方会按绑定的聊天补角色，不能在这里直接降成普通成员。
  const known = unique.flatMap((turn) => (turn.role ? [turn.role] : []))
  const role =
    known.length > 0
      ? known.reduce<Role>(
          (lowest, current) => (ROLE_RANK[current] < ROLE_RANK[lowest] ? current : lowest),
          "owner",
        )
      : undefined
  // 整批只有一个发送者时把 QQ 号带上，角色缺失时还能精确还原。
  const senders = new Set(unique.flatMap((turn) => (turn.senderId ? [turn.senderId] : [])))
  const senderId = senders.size === 1 ? senders.values().next().value : undefined
  return {
    // 合并后的批次沿用第一条消息的幂等键，重试时保持一致。
    ...(unique[0]?.id ? { id: unique[0].id } : {}),
    text: unique
      .map((turn) => turn.text.trim())
      .filter((text) => text.length > 0)
      .join("\n"),
    files: limitFiles(unique.flatMap((turn) => turn.files)),
    atMe,
    ...(wake ? { wake } : {}),
    ...(role ? { role } : {}),
    ...(senderId ? { senderId } : {}),
    ...(unique.some((turn) => turn.proactive) ? { proactive: true } : {}),
    ...(traceId ? { traceId } : {}),
    ...(suppress ? { suppress: true } : {}),
    ...(source ? { source } : {}),
  }
}

/** 判断两个模型引用是不是同一个。 */
function sameModel(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.id === right.id && left.providerID === right.providerID && left.variant === right.variant
  )
}

function turnBytes(turn: Turn): number {
  return (
    turn.text.length * 2 +
    turn.files.reduce((total, file) => total + (file.bytes ?? file.uri.length), 0)
  )
}

/**
 * 管理 QQ 群聊/私聊与 OpenCode 会话的映射。
 *
 * 一个目标固定对应一个会话，一个会话只能绑定一个目标；
 * 会话忙碌时新到的消息先缓存，等会话真正空闲之后再合并成新的一轮 prompt 发进去。
 */
export class SessionManager {
  private readonly states = new Map<string, ChatState>()
  private readonly sessions = new Map<string, ChatState>()
  private readonly targetMutexes = new Map<string, Mutex>()
  private readonly ensureMutexes = new Map<string, Mutex>()
  private readonly verifiedSessions = new Set<string>()
  private readonly outgoing = new Map<string, Set<string>>()
  private readonly incoming = new Map<string, Set<string>>()
  private readonly saveMutex = new Mutex()
  private activity: Record<string, number> = {}
  private bindingsLoaded: Promise<void> | undefined
  /** 每个目标已经投递到的位置。 */
  private readonly positions = new Map<string, HistoryPosition>()
  /** 启动时读到的位置快照，用于补齐重启期间错过的消息。 */
  private readonly restoredPositions = new Map<string, HistoryPosition>()
  /** 兜底轮询定时器：上游结束事件丢失时把缓存的消息投出去。 */
  private watchdog: ReturnType<typeof setTimeout> | undefined
  /** 每个目标上一次失败提示的时间戳。 */
  private readonly noticeAt = new Map<string, number>()
  /** 每个会话已经应用过的 agent / 模型覆盖，避免每条消息都切一次。 */
  private readonly appliedOverrides = new Map<string, { agent?: string; model?: ModelRef }>()
  private disposed = false

  constructor(
    private readonly ctx: Plugin.Context,
    private readonly config: QQBotConfig,
    private readonly logger: Logger,
    /** 机器人固定服务的工作目录，所有 QQ 会话都建在这里。 */
    private readonly home: BotHome,
    private readonly history?: HistoryProvider,
    /** 失败兜底通道；不传就只写日志。 */
    private readonly notify?: FailureNotifier,
    /** 按聊天覆盖 agent / 模型；不传就只用全局配置。 */
    private readonly overrides?: ChatOverrides,
    /** 调用链追踪器；不传就不记追踪。 */
    private readonly tracer?: Tracer,
  ) {}

  /** 会话统一落在机器人工作目录，避免接管后上下文散落到别的项目。 */
  private get location(): Location.PublicRef {
    // 目录最初就取自 location.directory，这里只是把存储里的字符串还原成品牌类型。
    return { directory: this.home.directory as Location.PublicRef["directory"] }
  }

  /** 载入上次运行时保存的目标与会话绑定。 */
  async load(): Promise<void> {
    await this.ensureBindings()
  }

  /**
   * 恢复重启前仍在执行的轮次。
   *
   * 上游会把没跑完的轮次接着跑；插件这边不恢复的话，模型再调用 QQ 工具
   * 就会被当成「没有轮次」而拒绝。只有上游确实还在执行时才恢复。
   */
  async restoreInflight(): Promise<number> {
    let stored: unknown
    try {
      stored = await this.ctx.storage.get(INFLIGHT_KEY)
    } catch (error) {
      this.logger.warn("读取在途轮次失败", error)
      return 0
    }
    const records =
      stored && typeof stored === "object" && !Array.isArray(stored)
        ? (stored as Record<string, unknown>)
        : {}
    let restored = 0
    for (const [key, value] of Object.entries(records)) {
      const target = parseTargetKey(key)
      if (!target || !isTargetAllowed(this.config.access, target, this.config.ownerQQ)) continue
      const record = parseInflight(value)
      if (!record) continue
      const state = this.states.get(targetKey(target))
      // 已经有这一轮的状态（例如刚从上一个实例接手）就不要覆盖。
      if (!state || state.current || state.sessionID !== record.sessionID) continue
      if (!(await this.sessionRunning(record.sessionID))) continue
      const role = record.role ?? this.roleFor(target, record.senderId)
      state.current = {
        text: "",
        files: [],
        atMe: record.atMe,
        role,
        ...(record.senderId ? { senderId: record.senderId } : {}),
        ...(record.wake ? { wake: record.wake } : {}),
        ...(record.proactive ? { proactive: true } : {}),
        ...(record.suppress ? { suppress: true } : {}),
        ...(record.traceId ? { traceId: record.traceId } : {}),
      }
      state.awaitingSend = record.awaitingSend
      state.reminders = record.reminders
      state.lastDispatchAt = record.lastDispatchAt
      state.idleAt = record.idleAt
      state.role = role
      restored += 1
      this.logger.warn(`${targetLabel(target)} 恢复重启前仍在执行的一轮，角色 ${role}`)
    }
    // 老版本或落盘失败时没有记录，但上游确实还在跑：按聊天恢复角色，
    // 至少别让这一轮调用 QQ 工具时被当成「没有轮次」。
    for (const state of this.states.values()) {
      if (!state.sessionID || state.current) continue
      if (records[targetKey(state.target)] !== undefined) continue
      if (!(await this.sessionRunning(state.sessionID))) continue
      const role = this.defaultRole(state.target)
      state.current = { text: "", files: [], atMe: false, role }
      state.role = role
      // 不知道模型是否已经发过，按还没发送处理：否则发送守卫会把第一次发送也拒掉。
      state.awaitingSend = true
      restored += 1
      this.logger.warn(`${targetLabel(state.target)} 上游仍在执行，按 ${role} 恢复这一轮的工具权限`)
    }
    return restored
  }

  private ensureBindings(): Promise<void> {
    this.bindingsLoaded ??= this.readBindings()
    return this.bindingsLoaded
  }

  /** 从插件存储恢复绑定；读取失败只告警，不影响正常使用。 */
  private async readBindings(): Promise<void> {
    let stored: unknown
    try {
      stored = await this.ctx.storage.get(BINDINGS_KEY)
    } catch (error) {
      this.logger.warn("读取会话绑定失败", error)
    }
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      let restored = 0
      for (const [key, value] of Object.entries(stored)) {
        const target = parseTargetKey(key)
        if (!target || typeof value !== "string" || value.length === 0) continue
        // 配置里已经移除的目标不再恢复，避免旧绑定继续获得工具权限。
        if (!isTargetAllowed(this.config.access, target, this.config.ownerQQ)) continue
        if (!this.bindSession(this.state(target), value)) continue
        restored += 1
      }
      if (restored > 0) this.logger.debug(`已恢复 ${restored} 个目标的会话绑定`)
    }

    try {
      const activity = await this.ctx.storage.get(ACTIVITY_KEY)
      if (activity && typeof activity === "object" && !Array.isArray(activity)) {
        for (const [key, value] of Object.entries(activity)) {
          const target = parseTargetKey(key)
          if (!target || typeof value !== "number" || !Number.isFinite(value)) continue
          if (!isTargetAllowed(this.config.access, target, this.config.ownerQQ)) continue
          this.activity[targetKey(target)] = value
          const state = this.states.get(targetKey(target))
          if (state) state.lastUserMessageAt = value
        }
      }
    } catch (error) {
      this.logger.warn("读取目标活跃时间失败", error)
    }

    await this.readPositions()
  }

  /** 从插件存储恢复每个目标已投递到的位置。 */
  private async readPositions(): Promise<void> {
    let stored: unknown
    try {
      stored = await this.ctx.storage.get(POSITIONS_KEY)
    } catch (error) {
      this.logger.warn("读取消息位置失败", error)
      return
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return
    for (const [key, value] of Object.entries(stored)) {
      const target = parseTargetKey(key)
      if (!target || !isTargetAllowed(this.config.access, target, this.config.ownerQQ)) continue
      const position = parsePosition(value)
      if (!position) continue
      this.positions.set(key, position)
      this.restoredPositions.set(key, position)
    }
  }

  /** 绑定或活跃时间变化后写回插件存储，串行执行避免互相覆盖。 */
  private scheduleSave(): void {
    void this.saveMutex
      .runExclusive(() => this.persist())
      .catch((error: unknown) => this.logger.error("保存会话状态失败", error))
  }

  private async persist(): Promise<void> {
    await this.writeBindings()
    await this.writeActivity()
    await this.writePositions()
    await this.writeInflight()
  }

  /** 写插件存储；失败只记日志，不影响主流程。 */
  private async store(key: string, value: StoredJson, failure: string): Promise<void> {
    try {
      await this.ctx.storage.set(key, value)
    } catch (error) {
      this.logger.error(failure, error)
    }
  }

  private async writeBindings(): Promise<void> {
    const bindings: Record<string, string> = {}
    for (const state of this.states.values()) {
      if (state.sessionID) bindings[targetKey(state.target)] = state.sessionID
    }
    await this.store(BINDINGS_KEY, bindings, "保存会话绑定失败")
  }

  private async writeActivity(): Promise<void> {
    await this.store(ACTIVITY_KEY, { ...this.activity }, "保存目标活跃时间失败")
  }

  private async writePositions(): Promise<void> {
    const data: Record<string, { id: string; time: number }> = Object.fromEntries(this.positions)
    await this.store(POSITIONS_KEY, data, "保存消息位置失败")
  }

  /** 把正在执行的轮次写回存储，重启后据此恢复工具权限。 */
  private async writeInflight(): Promise<void> {
    const inflight: Record<string, InflightTurn> = {}
    const now = Date.now()
    for (const state of this.states.values()) {
      const turn = state.current
      if (!turn || !state.sessionID) continue
      inflight[targetKey(state.target)] = {
        sessionID: state.sessionID,
        // 轮次没带角色时用会话角色，重启后不要丢掉 owner / 管理员。
        role: turn.role ?? state.role,
        ...(turn.senderId ? { senderId: turn.senderId } : {}),
        atMe: turn.atMe,
        ...(turn.wake ? { wake: turn.wake } : {}),
        ...(turn.suppress ? { suppress: true } : {}),
        ...(turn.proactive ? { proactive: true } : {}),
        ...(turn.traceId ? { traceId: turn.traceId } : {}),
        awaitingSend: state.awaitingSend,
        reminders: state.reminders,
        lastDispatchAt: state.lastDispatchAt,
        idleAt: state.idleAt,
        at: now,
      }
    }
    await this.store(INFLIGHT_KEY, inflight as unknown as StoredJson, "保存在途轮次失败")
  }

  /** 等待所有待写入的绑定落盘。 */
  async flush(): Promise<void> {
    await this.saveMutex.runExclusive(() => this.persist())
  }

  /** 取（必要时创建）某个键对应的互斥锁。 */
  private mutexFor(map: Map<string, Mutex>, key: string): Mutex {
    let mutex = map.get(key)
    if (!mutex) {
      mutex = new Mutex()
      map.set(key, mutex)
    }
    return mutex
  }

  /** 取目标对应的互斥锁，保证同一目标的状态变更与投递串行执行。 */
  private targetMutex(target: ChatTarget): Mutex {
    return this.mutexFor(this.targetMutexes, targetKey(target))
  }

  /** 建会话专用的锁，不能和投递锁共用：`Mutex` 不可重入，投递中建会话会死锁。 */
  private ensureMutex(target: ChatTarget): Mutex {
    return this.mutexFor(this.ensureMutexes, targetKey(target))
  }

  /**
   * 没有任何发送者信息时的角色：私聊按对方的 QQ 号判断，群聊只能按普通成员。
   *
   * 群聊消息入队时都带发送者 QQ 号，只有历史遗留或合成轮次才会走到这里；
   * 能拿到发送者时用 `roleFor` 精确判定。
   */
  private defaultRole(target: ChatTarget): Role {
    return roleForChat(this.config, target)
  }

  /** 按发送者 QQ 号还原角色；没有发送者时回退到聊天本身。 */
  private roleFor(target: ChatTarget, senderId?: string): Role {
    if (senderId) return roleOf(this.config, senderId)
    return this.defaultRole(target)
  }

  private state(target: ChatTarget): ChatState {
    const key = targetKey(target)
    let state = this.states.get(key)
    if (!state) {
      state = {
        target,
        role: this.defaultRole(target),
        buffer: [],
        pendingAttempts: 0,
        lastDispatchAt: 0,
        idleAt: 0,
        awaitingSend: false,
        reminders: 0,
        lastUserMessageAt: this.activity[key] ?? Date.now(),
        lastRetireAt: 0,
        replyAllowed: false,
      }
      this.states.set(key, state)
    }
    return state
  }

  /** 会话 ID 反查目标。 */
  targetForSession(sessionID: string): ChatTarget | undefined {
    return this.sessions.get(sessionID)?.target
  }

  /** 当前轮次的消息。 */
  currentTurn(sessionID: string): Turn | undefined {
    return this.sessions.get(sessionID)?.current
  }

  /** 该会话当前生效的发送者角色；有在途轮次时以轮次为准。 */
  currentRole(sessionID: string): Role {
    const state = this.sessions.get(sessionID)
    if (!state) return "member"
    return state.current?.role ?? state.role
  }

  /**
   * 正在执行的 QQ 轮次：目标、轮次本身与发送者角色。
   *
   * 没有轮次（TUI 里人工驱动）或会话没有绑定 QQ 目标时返回 undefined。
   */
  activeTurn(
    sessionID: string,
  ): { target: ChatTarget; turn: Turn; role: Role; replied: boolean } | undefined {
    const state = this.sessions.get(sessionID)
    if (!state?.current) return undefined
    return {
      target: state.target,
      turn: state.current,
      role: state.current.role ?? state.role,
      // 这一轮已经调用过发送工具（含被限流拒绝），别再发一遍。
      replied: !state.awaitingSend,
    }
  }

  /**
   * 导处在途状态，供实例交接时交给新实例。
   *
   * 只导出还有事情要做的聊天：正在执行的一轮、排队的消息、冻结的失败批次。
   */
  async exportHandover(): Promise<HandoverState[]> {
    const handover: HandoverState[] = []
    for (const state of this.states.values()) {
      if (!state.current && state.buffer.length === 0 && !state.pending) continue
      // 轮次挂上了但会话还没定下来：说明正卡在投递中途。等它落地再导出，
      // 否则接手的实例拿到的是一个投不到上游的空壳轮次。
      if (state.current && !state.sessionID) {
        await this.waitDispatch(state.target)
        if (!state.current && state.buffer.length === 0 && !state.pending) continue
      }
      handover.push({
        target: state.target,
        ...(state.sessionID ? { sessionID: state.sessionID } : {}),
        ...(state.current ? { current: state.current } : {}),
        awaitingSend: state.awaitingSend,
        reminders: state.reminders,
        lastDispatchAt: state.lastDispatchAt,
        idleAt: state.idleAt,
        buffer: [...state.buffer],
        ...(state.pending ? { pending: state.pending } : {}),
        pendingAttempts: state.pendingAttempts,
      })
    }
    return handover
  }

  /** 等这个聊天正在进行的投递结束，最多等 HANDOVER_WAIT_MS。 */
  private async waitDispatch(target: ChatTarget): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, HANDOVER_WAIT_MS)
      unrefTimer(timer)
    })
    try {
      await Promise.race([this.targetMutex(target).runExclusive(async () => {}), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 接管上一实例留下的状态。
   *
   * 实例被接管时，正在执行的一轮还在上游跑着；不接手的话，
   * 这一轮模型再调用发送工具就会被当成没有轮次而拒绝，回复直接丢掉。
   *
   * @returns 实际接手的聊天数量。
   */
  async adoptHandover(handover: readonly HandoverState[]): Promise<number> {
    let adopted = 0
    let changed = false
    for (const item of handover) {
      // 配置里已经移除的目标不再接管，避免旧状态继续获得工具权限。
      if (!isTargetAllowed(this.config.access, item.target, this.config.ownerQQ)) continue
      const state = this.state(item.target)
      // 已经有在途的事情就不接手，别把新实例自己的轮次顶掉。
      if (state.current || state.buffer.length > 0 || state.pending) continue
      if (state.sessionID && item.sessionID && state.sessionID !== item.sessionID) {
        this.logger.warn(
          `${targetLabel(item.target)} 交接时会话不一致（${state.sessionID} / ${item.sessionID}），保留原绑定`,
        )
        continue
      }
      if (item.sessionID && !(await this.sessionExists(item.sessionID))) {
        this.logger.warn(
          `${targetLabel(item.target)} 交接时会话 ${item.sessionID} 已不存在，丢弃这轮状态`,
        )
        continue
      }
      if (item.sessionID && !this.bindSession(state, item.sessionID)) continue
      // 没有会话的轮次根本没投到上游，接过来也只是个空壳。
      const current = item.current && item.sessionID ? item.current : undefined
      if (item.current && !current) {
        this.logger.warn(`${targetLabel(item.target)} 交接的轮次没有绑定会话，丢弃这一轮`)
      }
      state.current = current
      state.role = current?.role ?? this.defaultRole(item.target)
      state.awaitingSend = current ? item.awaitingSend : false
      state.reminders = current ? item.reminders : 0
      state.lastDispatchAt = item.lastDispatchAt
      state.idleAt = item.idleAt
      state.buffer = [...item.buffer]
      state.pending = item.pending
      state.pendingAttempts = item.pendingAttempts
      // 缓存里的消息已经收过，补历史时别再重复一遍。
      for (const turn of state.buffer) {
        if (turn.source) this.rememberIncoming(item.target, turn.source.id)
      }
      // 这一轮已经投递过，位置跟着走，别再补一次同样的历史。
      const source = current?.source
      if (source) {
        const key = targetKey(item.target)
        this.positions.set(key, source)
        this.restoredPositions.set(key, source)
      }
      if (item.sessionID || source) changed = true
      adopted += 1
    }
    // 接手的绑定与位置要落盘，重启后才知道这一轮已经投递到哪里。
    if (changed) this.scheduleSave()
    return adopted
  }

  /**
   * 重置一个聊天：先打断正在执行的回合，再解绑并删除会话。
   *
   * 下一条消息会新建会话并正常补历史；返回是否真的打断过。
   */
  async resetTarget(target: ChatTarget): Promise<{ sessionID?: string; interrupted: boolean }> {
    const state = this.state(target)
    const { sessionID, interrupted } = await this.detachSession(state)
    state.buffer = []
    state.pending = undefined
    state.pendingAttempts = 0
    state.idleAt = Date.now()
    this.resetTurnState(state, "resetTarget")
    return { sessionID, interrupted }
  }

  /**
   * 清掉一个聊天的轮次运行时状态并落盘。
   *
   * 排队消息与待重试批次由调用方决定是否一起清掉。
   */
  private resetTurnState(state: ChatState, reason: string): void {
    this.endTurn(state, reason)
    state.awaitingSend = false
    state.reminders = 0
    state.historyDone = false
    state.sessionCreated = false
    this.scheduleSave()
  }

  /**
   * 退役绑定的会话：先打断，再删掉上游会话。
   *
   * 会话删掉后，下一条消息会新建会话并重新补历史。
   */
  private async detachSession(
    state: ChatState,
  ): Promise<{ sessionID?: string; interrupted: boolean }> {
    const sessionID = state.sessionID
    if (!sessionID) return { interrupted: false }
    let interrupted = false
    if (await this.sessionRunning(sessionID)) {
      try {
        await this.ctx.session.interrupt({ sessionID })
        interrupted = true
      } catch (error) {
        this.logger.warn(`${targetLabel(state.target)} 打断会话 ${sessionID} 失败`, error)
      }
    }
    this.clearBinding(state)
    await this.ctx.session.remove({ sessionID }).catch((error: unknown) => {
      this.logger.warn(`${targetLabel(state.target)} 删除会话 ${sessionID} 失败`, error)
    })
    return { sessionID, interrupted }
  }

  /**
   * 连续投递失败后退役会话，让这个聊天重新能说话。
   *
   * 缓存里新到的消息保留：退役后由新会话接手，历史照常补齐。
   * 冷却时间内的重复失败不再重建，避免上游整体故障时反复新建会话。
   */
  private async retireSession(state: ChatState): Promise<void> {
    const sessionID = state.sessionID
    if (!sessionID) return
    const label = targetLabel(state.target)
    const now = Date.now()
    if (now - state.lastRetireAt < SESSION_RETIRE_COOLDOWN_MS) {
      this.logger.warn(`${label} 会话 ${sessionID} 刚退役过，暂时不再重建`)
      return
    }
    state.lastRetireAt = now
    await this.detachSession(state)
    // 新会话是空的，历史要重新补一次。
    this.resetTurnState(state, "retireSession")
    this.logger.warn(`${label} 会话 ${sessionID} 连续投递失败，已退役，下一条消息会新建会话`)
  }

  /** 各聊天当前状态的快照，供管理命令展示。 */
  snapshot(): Array<{
    target: ChatTarget
    sessionID?: string
    busy: boolean
    buffered: number
    pending: boolean
  }> {
    return [...this.states.values()]
      .map((state) => ({
        target: state.target,
        ...(state.sessionID ? { sessionID: state.sessionID } : {}),
        busy: state.current !== undefined,
        buffered: state.buffer.length,
        pending: state.pending !== undefined,
      }))
      .sort((left, right) => targetKey(left.target).localeCompare(targetKey(right.target)))
  }

  /**
   * 结束当前轮次，并记下是哪条路径清的。
   *
   * 所有清空 `current` 的地方都走这里，线上排查时能看出轮次是何时、被谁清掉的。
   */
  private endTurn(state: ChatState, reason: string): void {
    if (!state.current) {
      // 不清空也要保留上一次真正的原因，别让空跑覆盖掉关键证据。
      this.logger.debug(`${targetLabel(state.target)} 清轮次时已经没有轮次：${reason}`)
      return
    }
    const now = Date.now()
    state.lastClear = {
      reason,
      at: now,
      role: state.current.role ?? "member",
      ...(state.current.traceId ? { traceId: state.current.traceId } : {}),
    }
    this.logger.debug(`${targetLabel(state.target)} 清空当前轮次：${reason}`, {
      role: state.lastClear.role,
      ...(state.lastClear.traceId ? { trace_id: state.lastClear.traceId } : {}),
    })
    state.current = undefined
    // 发送权限只在本轮有效：轮次结束就收回，下一轮要重新说明理由。
    state.replyAllowed = false
    state.replyReason = undefined
    // 在途轮次落盘，重启后不会把已经结束的一轮又恢复出来。
    this.scheduleSave()
  }

  /** 当前是否有 QQ 消息轮次正在执行；仅用于查询与诊断，不再作为工具门禁。 */
  hasActiveTurn(sessionID: string): boolean {
    const active = this.sessions.get(sessionID)?.current !== undefined
    if (!active) {
      this.logger.debug(`会话 ${sessionID} 没有在执行的 QQ 轮次`, this.describeTurn(sessionID))
    }
    return active
  }

  /** 当前轮次的状态快照，供拒绝工具调用时定位原因。 */
  describeTurn(sessionID: string): Record<string, unknown> {
    const state = this.sessions.get(sessionID)
    if (!state) return { bound: false, now: Date.now() }
    return {
      bound: true,
      target: targetLabel(state.target),
      current: state.current
        ? {
            role: state.current.role ?? "member",
            proactive: state.current.proactive === true,
            ...(state.current.traceId ? { traceId: state.current.traceId } : {}),
          }
        : undefined,
      awaitingSend: state.awaitingSend,
      reminders: state.reminders,
      buffer: state.buffer.length,
      pending: state.pending !== undefined,
      lastDispatchAt: state.lastDispatchAt,
      idleAt: state.idleAt,
      lastClear: state.lastClear,
      replyAllowed: state.replyAllowed,
      replyReason: state.replyReason,
      now: Date.now(),
    }
  }

  /** 标记模型已经调用过发送工具。 */
  markMessageSent(sessionID: string): void {
    const state = this.sessions.get(sessionID)
    if (!state) return
    state.awaitingSend = false
    state.reminders = 0
    this.scheduleSave()
  }

  /**
   * 模型申请本轮的发送权限。
   *
   * 默认不给发送权限：模型得先说明为什么回复，拿到权限后才能调用发送工具。
   * 权限只在本轮有效，轮次结束就失效。
   *
   * @returns 是否批准。会话没有绑定或已经有权限时不算失败。
   */
  requestReply(sessionID: string, reason: string): { granted: boolean; reason: string } {
    const state = this.sessions.get(sessionID)
    if (!state) return { granted: false, reason }
    // 权限只在本轮有效：没有进行中的轮次就不给。
    if (!state.current) {
      this.logger.warn(`${targetLabel(state.target)} 没有进行中的轮次，不给发送权限`)
      return { granted: false, reason }
    }
    state.replyAllowed = true
    state.replyReason = reason
    this.logger.info(`${targetLabel(state.target)} 模型申请本轮发送权限：${reason}`)
    return { granted: true, reason }
  }

  /** 本轮是否已经拿到发送权限。 */
  canReply(sessionID: string): boolean {
    return this.sessions.get(sessionID)?.replyAllowed === true
  }

  /** 记录一条机器人发出的消息，撤回工具只能操作这些消息。 */
  rememberOutgoing(target: ChatTarget, messageId: string): void {
    this.track(this.outgoing, target, messageId)
  }

  /** 判断消息是否是机器人发出的。 */
  isOutgoing(target: ChatTarget, messageId: string): boolean {
    return this.outgoing.get(targetKey(target))?.has(messageId) ?? false
  }

  /**
   * 记录一条收到的消息，语音转写工具只能操作这些消息。
   *
   * 返回该 ID 是否首次出现，用于忽略 NapCat 重连后重放的同一条消息。
   */
  rememberIncoming(target: ChatTarget, messageId: string): boolean {
    return this.track(this.incoming, target, messageId)
  }

  /**
   * 把消息 ID 记进目标的集合，超出上限时丢弃最旧的一条。
   *
   * @returns 该 ID 是否是首次记录。
   */
  private track(map: Map<string, Set<string>>, target: ChatTarget, messageId: string): boolean {
    const key = targetKey(target)
    const ids = map.get(key) ?? new Set<string>()
    const isNew = !ids.has(messageId)
    ids.add(messageId)
    while (ids.size > MAX_TRACKED_MESSAGES) {
      const oldest = ids.values().next().value
      if (oldest === undefined) break
      ids.delete(oldest)
    }
    map.set(key, ids)
    return isNew
  }

  /** 判断消息是否属于当前目标最近收到的消息。 */
  isKnownMessage(target: ChatTarget, messageId: string): boolean {
    return (
      this.isOutgoing(target, messageId) ||
      (this.incoming.get(targetKey(target))?.has(messageId) ?? false)
    )
  }

  /** 记录一次真实用户消息的时间。 */
  touch(target: ChatTarget): void {
    const state = this.state(target)
    state.lastUserMessageAt = Date.now()
    this.activity[targetKey(target)] = state.lastUserMessageAt
    this.scheduleSave()
  }

  /** 距上次用户消息的沉默时长（秒）。 */
  silenceSeconds(target: ChatTarget): number {
    return (Date.now() - this.state(target).lastUserMessageAt) / 1000
  }

  /** 收到一条消息：先入队，再尝试投递；上游忙时留在队列里。 */
  async enqueue(target: ChatTarget, turn: Turn): Promise<void> {
    const state = this.state(target)
    const queued = turn.id ? turn : { ...turn, id: SessionMessage.ID.create() }
    await this.targetMutex(target).runExclusive(async () => {
      this.pushBuffered(state, queued)
      await this.drain(state)
    })
  }

  private pushBuffered(state: ChatState, turn: Turn): void {
    state.buffer.push(turn)
    let bytes = state.buffer.reduce((total, item) => total + turnBytes(item), 0)
    while (
      state.buffer.length > 1 &&
      (state.buffer.length > MAX_BUFFER_TURNS || bytes > MAX_BUFFER_BYTES)
    ) {
      const dropped = state.buffer.shift()
      if (!dropped) break
      bytes -= turnBytes(dropped)
      this.logger.warn(`${targetLabel(state.target)} 缓存已满，丢弃最早的一条消息`)
    }
    if (state.buffer.length === 1 && bytes > MAX_BUFFER_BYTES) {
      this.logger.warn(`${targetLabel(state.target)} 单条消息超过缓存上限，仍保留该消息`)
    }
    this.logger.info(`${targetLabel(state.target)} 消息已入队（累计 ${state.buffer.length} 条）`)
  }

  /** 上游会话是否仍在执行。 */
  private async sessionRunning(sessionID: string): Promise<boolean> {
    try {
      const info = await this.ctx.session.get({ sessionID })
      return upstreamRunning((info as { time?: unknown }).time)
    } catch (error) {
      this.logger.debug(`查询会话 ${sessionID} 状态失败`, error)
      return false
    }
  }

  /**
   * 结束信号是否属于更早的轮次。
   *
   * 上游 `time.idle` 只在执行结束时更新；它早于本次投递时间，说明这是上一轮
   * 迟到的 idle/结束事件，不能用来清理当前轮次的状态。
   */
  private async idleIsStale(state: ChatState): Promise<boolean> {
    if (!state.sessionID || state.lastDispatchAt === 0) return false
    try {
      const info = await this.ctx.session.get({ sessionID: state.sessionID })
      const time = (info as { time?: { idle?: unknown } }).time
      const idleAt = toMillis(time?.idle)
      const stale = idleAt !== undefined && idleAt < state.lastDispatchAt
      this.logger.debug(`${targetLabel(state.target)} 结束信号时间比对`, {
        idleAt,
        lastDispatchAt: state.lastDispatchAt,
        stale,
      })
      return stale
    } catch (error) {
      this.logger.debug(`${targetLabel(state.target)} 查询会话结束时间失败`, error)
      return false
    }
  }

  /**
   * 每次投递前都以上游状态为准：上游仍在跑就留在队列里，空闲才合并投递。
   * `force` 仅用于上游已经明确发出结束事件的场景。
   */
  private async drain(state: ChatState, force = false): Promise<void> {
    try {
      await this.deliver(state, force)
    } finally {
      // 缓存状态变了，重新决定要不要继续兜底轮询。
      this.syncWatchdog()
    }
  }

  /** 把缓存里的消息投进上游会话。 */
  private async deliver(state: ChatState, force = false): Promise<void> {
    // 上一批投递失败时，原样重试：内容与 id 都不能变。
    // 上游按 id 判定重复，同样的 id 带上不同内容会被判为冲突，那一批就永远送不进去。
    if (state.pending) {
      if (!(await this.dispatch(state, state.pending))) {
        state.pendingAttempts += 1
        if (state.pendingAttempts < PENDING_MAX_ATTEMPTS) {
          this.logger.warn(
            `${targetLabel(state.target)} 第 ${state.pendingAttempts} 次投递失败，仍会保留这批消息`,
          )
          return
        }
        // 重试到上限：上游可能永久拒绝这批内容，丢掉它，别把目标堵死。
        this.logger.error(
          `${targetLabel(state.target)} 连续 ${PENDING_MAX_ATTEMPTS} 次投递失败，丢弃这批消息`,
        )
        state.pending = undefined
        state.pendingAttempts = 0
        // 这批消息再也进不了会话，群里得有个交代。
        await this.notifyFailure(state, FAILURE_NOTICE)
        // 连着几轮都收不下消息的会话已经废了，继续绑着只会让这个聊天一直不回话。
        await this.retireSession(state)
      } else {
        state.pending = undefined
        state.pendingAttempts = 0
      }
    }
    if (state.buffer.length === 0) return
    if (!force && state.sessionID && this.verifiedSessions.has(state.sessionID)) {
      if (await this.sessionRunning(state.sessionID)) {
        this.logger.info(
          `${targetLabel(state.target)} 上游仍在执行，保留 ${state.buffer.length} 条消息`,
        )
        return
      }
      // 刚投递的轮次可能还没在上游留下忙碌时间，先给它一点时间。
      const idleConfirmed = state.idleAt > 0 && state.idleAt >= state.lastDispatchAt
      if (!idleConfirmed && Date.now() - state.lastDispatchAt < SUBMIT_GRACE_MS) return
    }

    const turns = state.buffer
    state.buffer = []
    // 历史在冻结 pending 之前拼好，重试时内容保持不变。
    const batch = await this.prepareTurn(state, mergeTurns(turns))
    if (!(await this.dispatch(state, batch))) {
      // 冻结这一批：重试时用同一个 id、同一段内容。
      state.pending = batch
      // 这次投递已经失败，算作第一次尝试。
      state.pendingAttempts = 1
    }
  }

  /**
   * 在本次运行的第一轮消息前面拼上历史记录。
   *
   * 新建会话补最近 N 条；复用上次的会话时只补上次投递位置之后的增量，
   * 这样重启期间错过的消息不会丢。历史已经实时收过的消息会被排除。
   */
  private async prepareTurn(state: ChatState, turn: Turn): Promise<Turn> {
    const count = Math.max(0, Math.floor(this.config.history.count))
    if (!this.history || count === 0 || state.historyDone) return turn

    const key = targetKey(state.target)
    const sessionID = await this.ensureSession(state.target)
    if (!sessionID) return turn
    const since = state.sessionCreated ? undefined : this.restoredPositions.get(key)
    try {
      const history = await this.history.fetch(state.target, {
        count,
        ...(since ? { since } : {}),
        exclude: this.incoming.get(key),
      })
      // 补过才算补齐：失败时不留下标记，下一轮还会重试。
      state.historyDone = true
      if (!history.text) return turn
      return {
        ...turn,
        text: `${history.text}\n${turn.text}`,
        files: limitFiles([...turn.files, ...history.files]),
      }
    } catch (error) {
      this.logger.warn(`${targetLabel(state.target)} 补齐历史失败`, error)
      return turn
    }
  }

  /** 把一轮消息投进 OpenCode 会话；失败时由调用方放回队列。 */
  private async dispatch(state: ChatState, turn: Turn): Promise<boolean> {
    // 轮次没带角色时按发送者 QQ 号补；没有发送者时再按聊天本身补。
    const role = turn.role ?? this.roleFor(state.target, turn.senderId)
    state.current = turn
    state.role = role
    state.awaitingSend = true
    // 新的用户轮次重新给一份提醒预算，否则连续几轮不调工具就再也提醒不了。
    state.reminders = 0
    const label = targetLabel(state.target)
    this.logger.debug(`${label} 开始投递一轮`, {
      role,
      proactive: turn.proactive === true,
      atMe: turn.atMe,
      ...(turn.traceId ? { trace_id: turn.traceId } : {}),
      ...(turn.source ? { source: turn.source } : {}),
    })
    let sessionID: string | undefined
    try {
      sessionID = await this.ensureSession(state.target)
      if (!sessionID) {
        this.endTurn(state, "dispatch: 没有会话")
        state.awaitingSend = false
        return false
      }
      // 先把在途状态落盘：进程在模型执行期间重启时，下一实例据此恢复工具权限。
      this.scheduleSave()
      // 模型起跑：从这里开始计时，看这一轮花了多久。
      if (turn.traceId) {
        await this.tracer?.record(
          "agent_start",
          turn.traceId,
          { session_id: sessionID, chars: turn.text.length },
          targetKey(state.target),
        )
      }
      await this.ctx.session.prompt({
        sessionID,
        ...(turn.id ? { id: turn.id } : {}),
        text: turn.text,
        ...(turn.files.length > 0 ? { files: turn.files } : {}),
      })
      state.lastDispatchAt = Date.now()
      if (turn.source) {
        const key = targetKey(state.target)
        this.positions.set(key, turn.source)
        // restoredPositions 是启动时的快照，用来算重启期间的增量，不能被本轮的投递改写。
        this.scheduleSave()
      }
      this.logger.info(`${label} 已投递消息到会话 ${sessionID}`, {
        ...(turn.traceId ? { trace_id: turn.traceId } : {}),
      })
      return true
    } catch (error) {
      this.endTurn(state, "dispatch: 投递失败")
      state.awaitingSend = false
      this.logger.error(`${label} 投递消息失败${sessionID ? `（会话 ${sessionID}）` : ""}`, error)
      return false
    }
  }

  /**
   * 会话即将空闲：有缓存就等结束事件再投递；否则按需提醒模型补一次发送。
   *
   * `background` 只统计本会话自己的后台任务；子会话遗留的任务不会唤醒本会话。
   */
  async handleIdle(
    sessionID: string,
    background: ReadonlyArray<{ sessionID: string }> = [],
  ): Promise<void> {
    const state = this.sessions.get(sessionID)
    if (!state) return
    await this.targetMutex(state.target).runExclusive(async () => {
      const label = targetLabel(state.target)
      this.logger.debug(`${label} 收到 idle 钩子`, this.describeTurn(sessionID))

      if (background.some((task) => task.sessionID === sessionID)) {
        this.logger.debug(`${label} 仍有后台任务，暂不投递缓存`)
        return
      }

      if (await this.idleIsStale(state)) {
        this.logger.debug(`${label} 忽略上一轮迟到的 idle 信号`)
        return
      }

      if (state.buffer.length > 0 || state.pending) {
        // 在 idle 钩子里投递会被并入旧的一轮；等结束事件后再作为新的一轮投递。
        const waiting = state.pending ? "重试上一批" : `投递 ${state.buffer.length} 条缓存消息`
        this.logger.debug(`${label} 空闲，等待${waiting}`)
        return
      }

      // 提醒沿用它正在提醒的那一轮的角色，别把 owner / 管理员降成普通成员。
      const reminderRole = state.current?.role ?? this.defaultRole(state.target)
      this.endTurn(state, "handleIdle")

      if (
        !state.awaitingSend ||
        !this.config.reminder.enabled ||
        state.reminders >= this.config.reminder.max
      ) {
        this.logger.debug(`${label} 空闲结束，不再提醒`, {
          awaitingSend: state.awaitingSend,
          reminderEnabled: this.config.reminder.enabled,
          reminders: state.reminders,
        })
        state.idleAt = Date.now()
        return
      }

      state.reminders += 1
      state.idleAt = 0
      state.lastDispatchAt = Date.now()
      state.current = {
        text: "[提醒]",
        files: [],
        atMe: false,
        ...(reminderRole ? { role: reminderRole } : {}),
      }
      this.logger.warn(`${label} 模型未调用发送工具，提醒第 ${state.reminders} 次`)
      // 群里默认没有发送权限，提醒里得说清楚先申请再发。
      const permissionHint =
        this.config.reply.requirePermission && state.target.kind === "group"
          ? "群里要先调用 qq_request_reply 说明为什么要回复，拿到权限后才能发送。"
          : ""
      try {
        await this.ctx.session.synthetic({
          sessionID,
          text: `[提醒] 你这一轮没有调用任何发送工具，直接输出的文字会被丢弃。请调用 qq_send_message 工具：想回复就 reply=true 并给出 content，不想回复就 reply=false；发送图片、语音、转发或戳一戳也视为已回复。${permissionHint}`,
        })
      } catch (error) {
        state.awaitingSend = false
        this.logger.error(`${label} 发送提醒失败`, error)
      }
    })
  }

  /**
   * 往聊天里补一条固定提示。
   *
   * 同一目标有冷却，连续失败只提示一次；发送失败也只写日志，不影响接下来的缓存投递。
   */
  private async notifyFailure(state: ChatState, text: string): Promise<void> {
    if (!this.notify) return
    const key = targetKey(state.target)
    const now = Date.now()
    const last = this.noticeAt.get(key)
    if (last !== undefined && now - last < FAILURE_NOTICE_INTERVAL_MS) return
    this.noticeAt.set(key, now)
    try {
      await this.notify(state.target, text)
      this.logger.debug(`${targetLabel(state.target)} 已补发失败提示`)
    } catch (error) {
      this.logger.warn(`${targetLabel(state.target)} 补发失败提示失败`, error)
    }
  }

  /**
   * 回合失败或被中断：结束事件之后直接放行缓存。
   *
   * 模型一句话都没发出时往聊天里补一条固定提示，否则群里表现为「不回话」。
   * 上游异常原文只进日志，绝不发到 QQ。
   */
  async handleExecutionEnd(sessionID: string, reason: string, detail?: string): Promise<void> {
    const state = this.sessions.get(sessionID)
    if (!state) return
    await this.targetMutex(state.target).runExclusive(async () => {
      this.logger.debug(
        `${targetLabel(state.target)} 收到执行结束事件（${reason}）`,
        this.describeTurn(sessionID),
      )
      if (await this.idleIsStale(state)) {
        this.logger.debug(`${targetLabel(state.target)} 忽略上一轮迟到的结束事件（${reason}）`)
        return
      }
      const label = targetLabel(state.target)
      const interrupted = reason === "session.execution.interrupted"
      this.logger.warn(`${label} 会话执行结束（${reason}）${detail ? `：${detail}` : ""}`)
      // 模型已经发过东西就不用再补提示；主动搭话失败也不往群里道歉。
      if (state.awaitingSend && !state.current?.proactive) {
        await this.notifyFailure(state, interrupted ? INTERRUPTED_NOTICE : FAILURE_NOTICE)
      }
      this.endTurn(state, `handleExecutionEnd: ${reason}`)
      state.awaitingSend = false
      state.idleAt = Date.now()
      await this.drain(state, true)
    })
  }

  /**
   * 执行结束事件丢失时，用上游会话状态兜底放行缓存。
   * 只在上游确认空闲且本轮确实结束后投递，不会打断仍在运行的长轮次。
   */
  async resumeBuffered(): Promise<void> {
    // 按目标遍历：还没绑定会话的目标同样可能有消息等着投递。
    for (const state of this.states.values()) {
      if (state.buffer.length === 0 && !state.pending) continue
      await this.targetMutex(state.target).runExclusive(() => this.drain(state))
    }
  }

  /** 是否还有消息等着投递。 */
  private hasPendingWork(): boolean {
    for (const state of this.states.values()) {
      if (state.buffer.length > 0 || state.pending) return true
    }
    return false
  }

  /**
   * 缓存里还有消息就保持兜底轮询，全部投出去后立刻停掉。
   *
   * 上游的结束事件可能丢失（断线、事件过期），没有这层兜底缓存的消息会一直压着。
   */
  private syncWatchdog(): void {
    if (this.disposed) return
    if (!this.hasPendingWork()) {
      if (this.watchdog) {
        clearTimeout(this.watchdog)
        this.watchdog = undefined
      }
      return
    }
    if (this.watchdog) return
    this.watchdog = setTimeout(() => {
      this.watchdog = undefined
      void this.runWatchdog()
    }, RESUME_INTERVAL_MS)
    unrefTimer(this.watchdog)
  }

  /** 兜底轮询一轮：按上游会话状态把缓存的消息放出去。 */
  private async runWatchdog(): Promise<void> {
    if (this.disposed) return
    try {
      await this.resumeBuffered()
    } catch (error) {
      this.logger.warn("兜底轮询缓存消息失败", error)
    } finally {
      this.syncWatchdog()
    }
  }

  /** 释放定时器等资源。 */
  dispose(): void {
    this.disposed = true
    if (this.watchdog) {
      clearTimeout(this.watchdog)
      this.watchdog = undefined
    }
  }

  /** 会话状态变为 idle 后，把缓存的消息合并成新的一轮投递。 */
  async flushBuffered(sessionID: string): Promise<void> {
    const state = this.sessions.get(sessionID)
    if (!state) return
    await this.targetMutex(state.target).runExclusive(async () => {
      this.logger.debug(
        `${targetLabel(state.target)} 收到空闲状态事件`,
        this.describeTurn(sessionID),
      )
      if (await this.idleIsStale(state)) {
        this.logger.debug(`${targetLabel(state.target)} 忽略上一轮迟到的结束信号`)
        return
      }
      if (state.buffer.length === 0 && !state.pending) {
        // 只有没有新轮次时，idle 时间才代表当前状态；投递缓存时若也写入，
        // 会与紧接着的 dispatch 落在同一毫秒，误判为新一轮已经结束。
        state.idleAt = Date.now()
        this.endTurn(state, "flushBuffered: 空闲且无缓存")
        return
      }
      this.logger.debug(`${targetLabel(state.target)} 空闲，投递 ${state.buffer.length} 条缓存消息`)
      await this.drain(state, true)
    })
  }

  /** 取得（必要时创建）目标对应的会话；并发调用串行执行，避免重复建会话。 */
  ensureSession(target: ChatTarget): Promise<string | undefined> {
    return this.ensureMutex(target).runExclusive(() => this.resolveSession(target))
  }

  private async resolveSession(target: ChatTarget): Promise<string | undefined> {
    await this.ensureBindings()
    const state = this.state(target)
    const label = targetLabel(target)
    // 覆盖优先于全局配置；没写覆盖就用全局的。
    const override = await this.overrides?.for(target)
    const agent = override?.agent ?? this.config.agent
    const model = override?.model ?? this.config.model
    if (state.sessionID) {
      if (await this.sessionExists(state.sessionID)) {
        await this.applyOverride(state.sessionID, label, agent, model)
        return state.sessionID
      }
      this.unbind(state)
    }

    if (this.config.reuseSession) {
      const reused = await this.findExistingSession(target)
      // 会话已经绑给别的目标时不能复用，改为新建一个会话。
      if (reused && this.bindSession(state, reused)) {
        this.verifiedSessions.add(reused)
        this.scheduleSave()
        this.logger.info(`${label} 复用已有会话 ${reused}`)
        await this.applyOverride(reused, label, agent, model)
        return reused
      }
    }

    const created = await this.ctx.session.create({
      title: target.kind === "group" ? `QQ 群 ${target.id}` : `QQ 私聊 ${target.id}`,
      location: this.location,
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      metadata: {
        qqTargetKind: target.kind,
        qqTargetId: target.id,
      },
    })
    if (!this.bindSession(state, created.id)) {
      this.logger.error(`${label} 新建会话 ${created.id} 已被其他目标占用`)
      await this.ctx.session.remove({ sessionID: created.id }).catch((error: unknown) => {
        this.logger.warn(`清理冲突会话 ${created.id} 失败`, error)
      })
      return undefined
    }
    this.verifiedSessions.add(created.id)
    state.sessionCreated = true
    // 新建时已经带上覆盖值，记下来就不必再切一次。
    this.appliedOverrides.set(created.id, { agent, model })
    this.scheduleSave()
    this.logger.info(`${label} 新建会话 ${created.id}`)
    return created.id
  }

  /**
   * 把 agent / 模型覆盖应用到已有会话。
   *
   * 只在覆盖真的变了的时候切换，避免每条消息都动一次会话。
   */
  private async applyOverride(
    sessionID: string,
    label: string,
    agent: string | undefined,
    model: ModelRef | undefined,
  ): Promise<void> {
    const applied = this.appliedOverrides.get(sessionID)
    if (applied?.agent === agent && sameModel(applied?.model, model)) return
    if (agent !== undefined && applied?.agent !== agent) {
      try {
        await this.ctx.session.switchAgent({ sessionID, agent })
        this.logger.info(`${label} 会话 ${sessionID} 切换到 agent ${agent}`)
      } catch (error) {
        this.logger.warn(`${label} 切换 agent ${agent} 失败`, error)
      }
    }
    if (model !== undefined && !sameModel(applied?.model, model)) {
      try {
        await this.ctx.session.switchModel({ sessionID, model })
        this.logger.info(`${label} 会话 ${sessionID} 切换到模型 ${model.providerID}/${model.id}`)
      } catch (error) {
        this.logger.warn(`${label} 切换模型失败`, error)
      }
    }
    this.appliedOverrides.set(sessionID, { agent, model })
  }

  /** 确认恢复的会话仍然存在，避免陈旧绑定让每条消息都失败。 */
  private async sessionExists(sessionID: string): Promise<boolean> {
    if (this.verifiedSessions.has(sessionID)) return true
    try {
      await this.ctx.session.get({ sessionID })
      this.verifiedSessions.add(sessionID)
      return true
    } catch (error) {
      this.logger.warn(`会话 ${sessionID} 已不存在，将重新建立绑定`, error)
      return false
    }
  }

  private unbind(state: ChatState): void {
    if (!state.sessionID) return
    this.clearBinding(state)
    this.scheduleSave()
  }

  /** 清掉会话绑定，不动上游会话。 */
  private clearBinding(state: ChatState): void {
    if (!state.sessionID) return
    this.sessions.delete(state.sessionID)
    this.verifiedSessions.delete(state.sessionID)
    this.appliedOverrides.delete(state.sessionID)
    state.sessionID = undefined
  }

  /** 绑定会话到目标；一个会话只能绑定一个目标，已有绑定不能被覆盖。 */
  private bindSession(state: ChatState, sessionID: string): boolean {
    if (state.sessionID && state.sessionID !== sessionID) {
      this.logger.error(
        `${targetLabel(state.target)} 已绑定会话 ${state.sessionID}，拒绝覆盖为 ${sessionID}`,
      )
      return false
    }
    const owner = this.sessions.get(sessionID)
    if (owner && targetKey(owner.target) !== targetKey(state.target)) {
      this.logger.error(
        `会话 ${sessionID} 已绑定 ${targetLabel(owner.target)}，不能再次绑定 ${targetLabel(state.target)}`,
      )
      return false
    }
    state.sessionID = sessionID
    this.sessions.set(sessionID, state)
    return true
  }

  /** 查找带相同目标标记的历史会话，按最近优先分页查找。 */
  private async findExistingSession(target: ChatTarget): Promise<string | undefined> {
    return await findSession(
      this.ctx,
      this.location.directory,
      (session) => {
        const metadata = session.metadata
        return metadata?.["qqTargetKind"] === target.kind && metadata["qqTargetId"] === target.id
      },
      this.logger,
      `查找历史会话失败 ${targetLabel(target)}`,
    )
  }

  /** 主动说话：向目标对应的会话投递一条合成消息。 */
  async proactive(target: ChatTarget, text: string): Promise<void> {
    const state = this.state(target)
    await this.targetMutex(target).runExclusive(async () => {
      if (state.buffer.length > 0 || state.current) return
      const traceId = this.tracer?.startTrace()
      // 先占位，避免用户消息或下一次心跳同时投递。
      state.idleAt = 0
      state.lastDispatchAt = Date.now()
      state.current = {
        text,
        files: [],
        atMe: true,
        proactive: true,
        // 主动说话没有人参与，上下文完全来自聊天内容，权限按最低算。
        role: "proactive",
        ...(traceId ? { traceId } : {}),
      }
      state.role = "proactive"
      state.awaitingSend = true
      state.reminders = 0
      try {
        if (state.sessionID && (await this.sessionRunning(state.sessionID))) {
          this.endTurn(state, "proactive: 上游仍在执行")
          state.awaitingSend = false
          return
        }
        const sessionID = await this.ensureSession(target)
        if (!sessionID) {
          this.endTurn(state, "proactive: 没有会话")
          state.awaitingSend = false
          return
        }
        this.scheduleSave()
        state.lastUserMessageAt = Date.now()
        this.activity[targetKey(target)] = state.lastUserMessageAt
        this.scheduleSave()
        if (traceId) {
          await this.tracer?.record(
            "agent_start",
            traceId,
            { session_id: sessionID, proactive: true },
            targetKey(target),
          )
        }
        await this.ctx.session.synthetic({ sessionID, text })
      } catch (error) {
        state.awaitingSend = false
        this.endTurn(state, "proactive: 投递失败")
        this.logger.error(`${targetLabel(target)} 主动说话失败`, error)
      }
    })
  }
}
