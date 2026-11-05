import { randomUUID } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { Mutex } from "async-mutex"
import { type ChatTarget, isTargetEnabled, parseTargetKey, targetKey, targetLabel } from "../chat"
import type { QQBotConfig } from "../config"
import type { Logger } from "../logger"
import { limitFiles, type PromptFile } from "../naplink/render"

/** 插件存储里保存会话与目标绑定的键。 */
const BINDINGS_KEY = "bindings"
/** 插件存储里保存目标最近活跃时间的键。 */
const ACTIVITY_KEY = "activity"
/** 单个目标最多缓存的消息条数。 */
export const MAX_BUFFER_TURNS = 100
/** 单个目标最多缓存的文本与附件字节数。 */
export const MAX_BUFFER_BYTES = 32 * 1024 * 1024
/** 每个目标最多记录的消息 ID 数量。 */
const MAX_TRACKED_MESSAGES = 200
/** 刚投递的一轮还没在上游体现出忙碌状态，先跳过对账避免重复投递。 */
export const SUBMIT_GRACE_MS = 5_000
function toMillis(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime()
  if (typeof value === "number") return value
  return undefined
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
  /** 本轮是否 @ 了机器人。 */
  atMe: boolean
  /** 是否由主动说话心跳发起。 */
  proactive?: boolean
}

interface ChatState {
  target: ChatTarget
  sessionID?: string
  /** 等上游空闲后要投递的消息。 */
  buffer: Turn[]
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
}

type SessionListCursor = NonNullable<Parameters<Plugin.Context["session"]["list"]>[0]>["cursor"]

export function mergeTurns(turns: readonly Turn[]): Turn {
  return {
    // 合并后的批次沿用第一条消息的幂等键，重试时保持一致。
    ...(turns[0]?.id ? { id: turns[0].id } : {}),
    text: turns
      .map((turn) => turn.text.trim())
      .filter((text) => text.length > 0)
      .join("\n"),
    files: limitFiles(turns.flatMap((turn) => turn.files)),
    atMe: turns.some((turn) => turn.atMe),
    ...(turns.some((turn) => turn.proactive) ? { proactive: true } : {}),
  }
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

  constructor(
    private readonly ctx: Plugin.Context,
    private readonly config: QQBotConfig,
    private readonly logger: Logger,
  ) {}

  /** 载入上次运行时保存的目标与会话绑定。 */
  async load(): Promise<void> {
    await this.ensureBindings()
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
        if (!isTargetEnabled(this.config, target)) continue
        if (!this.bindSession(this.state(target), value)) continue
        restored += 1
      }
      if (restored > 0) this.logger.debug(`已恢复 ${restored} 个目标的会话绑定`)
    }

    try {
      const activity = await this.ctx.storage.get(ACTIVITY_KEY)
      if (!activity || typeof activity !== "object" || Array.isArray(activity)) return
      for (const [key, value] of Object.entries(activity)) {
        const target = parseTargetKey(key)
        if (!target || typeof value !== "number" || !Number.isFinite(value)) continue
        if (!isTargetEnabled(this.config, target)) continue
        this.activity[targetKey(target)] = value
        const state = this.states.get(targetKey(target))
        if (state) state.lastUserMessageAt = value
      }
    } catch (error) {
      this.logger.warn("读取目标活跃时间失败", error)
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
  }

  private async writeBindings(): Promise<void> {
    const bindings: Record<string, string> = {}
    for (const state of this.states.values()) {
      if (state.sessionID) bindings[targetKey(state.target)] = state.sessionID
    }
    try {
      await this.ctx.storage.set(BINDINGS_KEY, bindings)
    } catch (error) {
      this.logger.error("保存会话绑定失败", error)
    }
  }

  private async writeActivity(): Promise<void> {
    try {
      await this.ctx.storage.set(ACTIVITY_KEY, { ...this.activity })
    } catch (error) {
      this.logger.error("保存目标活跃时间失败", error)
    }
  }

  /** 等待所有待写入的绑定落盘。 */
  async flush(): Promise<void> {
    await this.saveMutex.runExclusive(() => this.persist())
  }

  /** 取目标对应的互斥锁，保证同一目标的状态变更与投递串行执行。 */
  private targetMutex(target: ChatTarget): Mutex {
    const key = targetKey(target)
    let mutex = this.targetMutexes.get(key)
    if (!mutex) {
      mutex = new Mutex()
      this.targetMutexes.set(key, mutex)
    }
    return mutex
  }

  private ensureMutex(target: ChatTarget): Mutex {
    const key = targetKey(target)
    let mutex = this.ensureMutexes.get(key)
    if (!mutex) {
      mutex = new Mutex()
      this.ensureMutexes.set(key, mutex)
    }
    return mutex
  }

  private state(target: ChatTarget): ChatState {
    const key = targetKey(target)
    let state = this.states.get(key)
    if (!state) {
      state = {
        target,
        buffer: [],
        lastDispatchAt: 0,
        idleAt: 0,
        awaitingSend: false,
        reminders: 0,
        lastUserMessageAt: this.activity[key] ?? Date.now(),
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

  /** 当前是否有 QQ 消息轮次正在执行，用于阻止手动 prompt 调用 QQ 工具。 */
  hasActiveTurn(sessionID: string): boolean {
    return this.sessions.get(sessionID)?.current !== undefined
  }

  /** 标记模型已经调用过发送工具。 */
  markMessageSent(sessionID: string): void {
    const state = this.sessions.get(sessionID)
    if (!state) return
    state.awaitingSend = false
    state.reminders = 0
  }

  /** 记录一条机器人发出的消息，撤回工具只能操作这些消息。 */
  rememberOutgoing(target: ChatTarget, messageId: string): void {
    const key = targetKey(target)
    const ids = this.outgoing.get(key) ?? new Set<string>()
    ids.add(messageId)
    while (ids.size > MAX_TRACKED_MESSAGES) {
      const oldest = ids.values().next().value
      if (oldest === undefined) break
      ids.delete(oldest)
    }
    this.outgoing.set(key, ids)
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
    const key = targetKey(target)
    const ids = this.incoming.get(key) ?? new Set<string>()
    const isNew = !ids.has(messageId)
    ids.add(messageId)
    while (ids.size > MAX_TRACKED_MESSAGES) {
      const oldest = ids.values().next().value
      if (oldest === undefined) break
      ids.delete(oldest)
    }
    this.incoming.set(key, ids)
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
    const queued = turn.id ? turn : { ...turn, id: randomUUID() }
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
    this.logger.debug(`${targetLabel(state.target)} 消息已入队（累计 ${state.buffer.length} 条）`)
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
      return idleAt !== undefined && idleAt < state.lastDispatchAt
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
    if (state.buffer.length === 0) return
    if (!force && state.sessionID && this.verifiedSessions.has(state.sessionID)) {
      if (await this.sessionRunning(state.sessionID)) {
        this.logger.debug(
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
    if (!(await this.dispatch(state, mergeTurns(turns)))) {
      state.buffer = [...turns, ...state.buffer]
    }
  }

  /** 把一轮消息投进 OpenCode 会话；失败时由调用方放回队列。 */
  private async dispatch(state: ChatState, turn: Turn): Promise<boolean> {
    state.current = turn
    state.awaitingSend = true
    // 新的用户轮次重新给一份提醒预算，否则连续几轮不调工具就再也提醒不了。
    state.reminders = 0
    const label = targetLabel(state.target)
    try {
      const sessionID = await this.ensureSession(state.target)
      if (!sessionID) {
        state.current = undefined
        state.awaitingSend = false
        return false
      }
      await this.ctx.session.prompt({
        sessionID,
        ...(turn.id ? { id: turn.id } : {}),
        text: turn.text,
        ...(turn.files.length > 0 ? { files: turn.files } : {}),
      })
      state.lastDispatchAt = Date.now()
      this.logger.debug(`${label} 已投递消息到会话 ${sessionID}`)
      return true
    } catch (error) {
      state.current = undefined
      state.awaitingSend = false
      this.logger.error(`${label} 投递消息失败`, error)
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

      if (background.some((task) => task.sessionID === sessionID)) {
        this.logger.debug(`${label} 仍有后台任务，暂不投递缓存`)
        return
      }

      if (await this.idleIsStale(state)) {
        this.logger.debug(`${label} 忽略上一轮迟到的 idle 信号`)
        return
      }

      if (state.buffer.length > 0) {
        // 在 idle 钩子里投递会被并入旧的一轮；等结束事件后再作为新的一轮投递。
        this.logger.debug(`${label} 空闲，等待投递 ${state.buffer.length} 条缓存消息`)
        return
      }

      state.current = undefined

      if (
        !state.awaitingSend ||
        !this.config.reminder.enabled ||
        state.reminders >= this.config.reminder.max
      ) {
        state.idleAt = Date.now()
        return
      }

      state.reminders += 1
      state.idleAt = 0
      state.lastDispatchAt = Date.now()
      state.current = { text: "[提醒]", files: [], atMe: false }
      this.logger.warn(`${label} 模型未调用发送工具，提醒第 ${state.reminders} 次`)
      try {
        await this.ctx.session.synthetic({
          sessionID,
          text: `[提醒] 你这一轮没有调用任何发送工具，直接输出的文字会被丢弃。请调用 qq_send_message 工具：想回复就 reply=true 并给出 content，不想回复就 reply=false；发送图片、语音、转发或戳一戳也视为已回复。`,
        })
      } catch (error) {
        state.awaitingSend = false
        this.logger.error(`${label} 发送提醒失败`, error)
      }
    })
  }

  /** 模型执行失败或被中断：结束事件之后直接放行缓存。 */
  async handleExecutionEnd(sessionID: string, reason: string): Promise<void> {
    const state = this.sessions.get(sessionID)
    if (!state) return
    await this.targetMutex(state.target).runExclusive(async () => {
      if (await this.idleIsStale(state)) {
        this.logger.debug(`${targetLabel(state.target)} 忽略上一轮迟到的结束事件（${reason}）`)
        return
      }
      this.logger.warn(`${targetLabel(state.target)} 会话执行结束（${reason}）`)
      state.current = undefined
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
    for (const state of this.sessions.values()) {
      if (state.buffer.length === 0) continue
      await this.targetMutex(state.target).runExclusive(() => this.drain(state))
    }
  }

  /** 会话状态变为 idle 后，把缓存的消息合并成新的一轮投递。 */
  async flushBuffered(sessionID: string): Promise<void> {
    const state = this.sessions.get(sessionID)
    if (!state) return
    await this.targetMutex(state.target).runExclusive(async () => {
      if (await this.idleIsStale(state)) {
        this.logger.debug(`${targetLabel(state.target)} 忽略上一轮迟到的结束信号`)
        return
      }
      if (state.buffer.length === 0) {
        // 只有没有新轮次时，idle 时间才代表当前状态；投递缓存时若也写入，
        // 会与紧接着的 dispatch 落在同一毫秒，误判为新一轮已经结束。
        state.idleAt = Date.now()
        state.current = undefined
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
    if (state.sessionID) {
      if (await this.sessionExists(state.sessionID)) return state.sessionID
      this.unbind(state)
    }

    if (this.config.reuseSession) {
      const reused = await this.findExistingSession(target)
      // 会话已经绑给别的目标时不能复用，改为新建一个会话。
      if (reused && this.bindSession(state, reused)) {
        this.verifiedSessions.add(reused)
        this.scheduleSave()
        this.logger.info(`${label} 复用已有会话 ${reused}`)
        return reused
      }
    }

    const created = await this.ctx.session.create({
      title: target.kind === "group" ? `QQ 群 ${target.id}` : `QQ 私聊 ${target.id}`,
      ...(this.config.agent ? { agent: this.config.agent } : {}),
      ...(this.config.model ? { model: this.config.model } : {}),
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
    this.scheduleSave()
    this.logger.info(`${label} 新建会话 ${created.id}`)
    return created.id
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
    this.sessions.delete(state.sessionID)
    this.verifiedSessions.delete(state.sessionID)
    state.sessionID = undefined
    this.scheduleSave()
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
    let cursor: SessionListCursor | undefined
    try {
      for (let page = 0; page < 5; page += 1) {
        const result = await this.ctx.session.list({
          directory: this.ctx.location.directory,
          limit: 100,
          order: "desc",
          ...(cursor ? { cursor } : {}),
        })
        const hit = result.data.find((session) => {
          const metadata = session.metadata
          return metadata?.["qqTargetKind"] === target.kind && metadata["qqTargetId"] === target.id
        })
        if (hit) return hit.id
        cursor = result.cursor.next ?? undefined
        if (!cursor) break
      }
    } catch (error) {
      this.logger.warn(`查找历史会话失败 ${targetLabel(target)}`, error)
    }
    return undefined
  }

  /** 该目标是否已经建立过会话。 */
  hasSession(target: ChatTarget): boolean {
    return this.states.get(targetKey(target))?.sessionID !== undefined
  }

  /** 主动说话：向目标对应的会话投递一条合成消息。 */
  async proactive(target: ChatTarget, text: string): Promise<void> {
    const state = this.state(target)
    await this.targetMutex(target).runExclusive(async () => {
      if (state.buffer.length > 0 || state.current) return
      // 先占位，避免用户消息或下一次心跳同时投递。
      state.idleAt = 0
      state.lastDispatchAt = Date.now()
      state.current = { text, files: [], atMe: true, proactive: true }
      state.awaitingSend = true
      state.reminders = 0
      try {
        if (state.sessionID && (await this.sessionRunning(state.sessionID))) {
          state.current = undefined
          state.awaitingSend = false
          return
        }
        const sessionID = await this.ensureSession(target)
        if (!sessionID) {
          state.current = undefined
          state.awaitingSend = false
          return
        }
        state.lastUserMessageAt = Date.now()
        this.activity[targetKey(target)] = state.lastUserMessageAt
        this.scheduleSave()
        await this.ctx.session.synthetic({ sessionID, text })
      } catch (error) {
        state.awaitingSend = false
        state.current = undefined
        this.logger.error(`${targetLabel(target)} 主动说话失败`, error)
      }
    })
  }
}
