import type { Plugin } from "@opencode/plugin"
import type { QQBotConfig } from "../config"
import type { Logger } from "../logger"
import { limitFiles, type PromptFile } from "../naplink/render"

/** 插件存储里保存群与会话绑定的键。 */
const BINDINGS_KEY = "bindings"
/** 插件存储里保存群最近活跃时间的键。 */
const ACTIVITY_KEY = "activity"
/** 单个群最多缓存的消息条数。 */
export const MAX_BUFFER_TURNS = 100
/** 单个群最多缓存的文本与附件字节数。 */
export const MAX_BUFFER_BYTES = 32 * 1024 * 1024
/** 每个群最多记录的消息 ID 数量。 */
const MAX_TRACKED_MESSAGES = 200

export interface Turn {
  /** 交给模型的文本。 */
  text: string
  /** 图片附件。 */
  files: PromptFile[]
  /** 本轮是否 @ 了机器人。 */
  atMe: boolean
  /** 是否由主动说话心跳发起。 */
  proactive?: boolean
}

interface GroupState {
  groupId: number
  sessionID?: string
  /** 会话是否正在跑模型（收到消息到 idle 之间）。 */
  busy: boolean
  /** 进入忙碌状态的时间戳（毫秒），用于识别卡死的会话。 */
  busySince: number
  /** 忙碌超时看门狗。 */
  busyTimer?: ReturnType<typeof setTimeout>
  /** 忙碌期间攒下的消息，空闲后合并成一次 prompt。 */
  buffer: Turn[]
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
  return turn.text.length * 2 + turn.files.reduce((total, file) => total + file.uri.length, 0)
}

/**
 * 管理 QQ 群与 OpenCode 会话的映射。
 *
 * 一个群固定对应一个会话，一个会话只能绑定一个群；
 * 会话忙碌时新到的消息先缓存，等会话真正空闲之后再合并成新的一轮 prompt 发进去。
 */
export class SessionManager {
  private readonly groups = new Map<number, GroupState>()
  private readonly sessions = new Map<string, GroupState>()
  private readonly ensureRequests = new Map<number, Promise<string | undefined>>()
  private readonly verifiedSessions = new Set<string>()
  private readonly outgoing = new Map<number, Set<string>>()
  private readonly incoming = new Map<number, Set<string>>()
  private activity: Record<string, number> = {}
  private bindingsLoaded: Promise<void> | undefined
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly ctx: Plugin.Context,
    private readonly config: QQBotConfig,
    private readonly logger: Logger,
  ) {}

  /** 载入上次运行时保存的群与会话绑定。 */
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
        const groupId = Number(key)
        if (!Number.isInteger(groupId) || typeof value !== "string" || value.length === 0) continue
        // 配置里已经移除的群不再恢复，避免旧绑定继续获得工具权限。
        if (!this.config.groups.includes(groupId)) continue
        if (!this.bindSession(this.state(groupId), value)) continue
        restored += 1
      }
      if (restored > 0) this.logger.debug(`已恢复 ${restored} 个群的会话绑定`)
    }

    try {
      const activity = await this.ctx.storage.get(ACTIVITY_KEY)
      if (!activity || typeof activity !== "object" || Array.isArray(activity)) return
      for (const [key, value] of Object.entries(activity)) {
        const groupId = Number(key)
        if (!Number.isInteger(groupId) || typeof value !== "number" || !Number.isFinite(value)) {
          continue
        }
        if (!this.config.groups.includes(groupId)) continue
        this.activity[String(groupId)] = value
        const state = this.groups.get(groupId)
        if (state) state.lastUserMessageAt = value
      }
    } catch (error) {
      this.logger.warn("读取群活跃时间失败", error)
    }
  }

  /** 绑定或活跃时间变化后写回插件存储，串行执行避免互相覆盖。 */
  private scheduleSave(): void {
    this.saveQueue = this.saveQueue.then(() => this.persist())
  }

  private async persist(): Promise<void> {
    await this.writeBindings()
    await this.writeActivity()
  }

  private async writeBindings(): Promise<void> {
    const bindings: Record<string, string> = {}
    for (const [groupId, state] of this.groups) {
      if (state.sessionID) bindings[String(groupId)] = state.sessionID
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
      this.logger.error("保存群活跃时间失败", error)
    }
  }

  /** 等待所有待写入的绑定落盘。 */
  async flush(): Promise<void> {
    await this.saveQueue
    await this.persist()
  }

  private state(groupId: number): GroupState {
    let state = this.groups.get(groupId)
    if (!state) {
      state = {
        groupId,
        busy: false,
        busySince: 0,
        buffer: [],
        awaitingSend: false,
        reminders: 0,
        lastUserMessageAt: this.activity[String(groupId)] ?? Date.now(),
      }
      this.groups.set(groupId, state)
    }
    return state
  }

  private beginBusy(state: GroupState): void {
    state.busy = true
    state.busySince = Date.now()
    this.armBusyTimer(state)
  }

  private armBusyTimer(state: GroupState): void {
    this.clearBusyTimer(state)
    state.busyTimer = setTimeout(() => {
      void this.recoverGroup(state.groupId)
    }, this.config.busyTimeoutMs)
    const timer = state.busyTimer as { unref?: () => void }
    timer.unref?.()
  }

  private clearBusyTimer(state: GroupState): void {
    if (state.busyTimer === undefined) return
    clearTimeout(state.busyTimer)
    state.busyTimer = undefined
  }

  private endBusy(state: GroupState): void {
    state.busy = false
    state.busySince = 0
    this.clearBusyTimer(state)
  }

  /** 会话 ID 反查群号。 */
  groupForSession(sessionID: string): number | undefined {
    return this.sessions.get(sessionID)?.groupId
  }

  /** 当前轮次的消息。 */
  currentTurn(sessionID: string): Turn | undefined {
    return this.sessions.get(sessionID)?.current
  }

  /** 当前是否有 QQ 消息轮次正在执行，用于阻止手动 prompt 调用群工具。 */
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
  rememberOutgoing(groupId: number | string, messageId: string): void {
    const key = Number(groupId)
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
  isOutgoing(groupId: number | string, messageId: string): boolean {
    return this.outgoing.get(Number(groupId))?.has(messageId) ?? false
  }

  /** 记录一条收到的消息，语音转写工具只能操作这些消息。 */
  rememberIncoming(groupId: number | string, messageId: string): void {
    const key = Number(groupId)
    const ids = this.incoming.get(key) ?? new Set<string>()
    ids.add(messageId)
    while (ids.size > MAX_TRACKED_MESSAGES) {
      const oldest = ids.values().next().value
      if (oldest === undefined) break
      ids.delete(oldest)
    }
    this.incoming.set(key, ids)
  }

  /** 判断消息是否属于当前群最近收到的消息。 */
  isKnownMessage(groupId: number | string, messageId: string): boolean {
    return (
      this.isOutgoing(groupId, messageId) ||
      (this.incoming.get(Number(groupId))?.has(messageId) ?? false)
    )
  }

  /** 记录一次真实用户消息的时间。 */
  touch(groupId: number): void {
    const state = this.state(groupId)
    state.lastUserMessageAt = Date.now()
    this.activity[String(groupId)] = state.lastUserMessageAt
    this.scheduleSave()
  }

  /** 距上次用户消息的沉默时长（秒）。 */
  silenceSeconds(groupId: number): number {
    return (Date.now() - this.state(groupId).lastUserMessageAt) / 1000
  }

  /**
   * 收到一条群消息：空闲则直接投进会话，忙则先缓存。
   */
  async enqueue(groupId: number, turn: Turn): Promise<void> {
    const state = this.state(groupId)
    if (state.busy) {
      this.pushBuffered(state, turn)
      return
    }
    await this.dispatch(groupId, state, turn)
  }

  private pushBuffered(state: GroupState, turn: Turn): void {
    state.buffer.push(turn)
    let bytes = state.buffer.reduce((total, item) => total + turnBytes(item), 0)
    while (
      state.buffer.length > 1 &&
      (state.buffer.length > MAX_BUFFER_TURNS || bytes > MAX_BUFFER_BYTES)
    ) {
      const dropped = state.buffer.shift()
      if (!dropped) break
      bytes -= turnBytes(dropped)
      this.logger.warn(`群 ${state.groupId} 缓存已满，丢弃最早的一条消息`)
    }
    if (state.buffer.length === 1 && bytes > MAX_BUFFER_BYTES) {
      this.logger.warn(`群 ${state.groupId} 单条消息超过缓存上限，仍保留该消息`)
    }
    this.logger.debug(`群 ${state.groupId} 忙碌中，消息已缓存（累计 ${state.buffer.length} 条）`)
  }

  /** 把一轮消息投进 OpenCode 会话。 */
  private async dispatch(groupId: number, state: GroupState, turn: Turn): Promise<void> {
    if (state.busy) return
    // 先同步占位，避免并发消息重复投递
    this.beginBusy(state)
    state.current = turn
    state.awaitingSend = true
    // 新的用户轮次重新给一份提醒预算，否则连续几轮不调工具就再也提醒不了。
    state.reminders = 0
    try {
      const sessionID = await this.ensureSession(groupId)
      if (!sessionID) {
        this.endBusy(state)
        state.current = undefined
        state.awaitingSend = false
        return
      }
      await this.ctx.session.prompt({
        sessionID,
        text: turn.text,
        ...(turn.files.length > 0 ? { files: turn.files } : {}),
      })
      this.logger.debug(`群 ${groupId} 已投递消息到会话 ${sessionID}`)
    } catch (error) {
      this.endBusy(state)
      state.current = undefined
      state.awaitingSend = false
      this.logger.error(`群 ${groupId} 投递消息失败`, error)
      const buffered = state.buffer
      state.buffer = []
      if (buffered.length > 0) {
        await this.dispatch(groupId, state, mergeTurns(buffered))
      }
    }
  }

  /**
   * 会话即将空闲：若有缓存消息，保持忙碌等 session.idle 后再投递；
   * 否则清掉忙碌标记，若模型这一轮没调用发送工具则提醒它补一次。
   *
   * `background` 只统计本会话自己的后台任务；子会话遗留的任务不会唤醒本会话，
   * 不能因此让群一直保持忙碌。
   */
  async handleIdle(
    sessionID: string,
    background: ReadonlyArray<{ sessionID: string }> = [],
  ): Promise<void> {
    const state = this.sessions.get(sessionID)
    if (!state) return

    if (background.some((task) => task.sessionID === sessionID)) {
      this.logger.debug(`群 ${state.groupId} 仍有后台任务，保持忙碌状态`)
      return
    }

    if (state.buffer.length > 0) {
      // 在 idle 钩子里投递会被并入旧的一轮；保持忙碌，等真正空闲后再开始新一轮。
      this.logger.debug(`群 ${state.groupId} 空闲，等待投递 ${state.buffer.length} 条缓存消息`)
      return
    }

    this.endBusy(state)
    state.current = undefined

    if (
      state.awaitingSend &&
      this.config.reminder.enabled &&
      state.reminders < this.config.reminder.max
    ) {
      state.reminders += 1
      // 合成消息会唤醒会话再跑一轮，先占位避免新消息插队。
      this.beginBusy(state)
      state.current = { text: "[提醒]", files: [], atMe: false }
      this.logger.warn(`群 ${state.groupId} 模型未调用发送工具，提醒第 ${state.reminders} 次`)
      try {
        await this.ctx.session.synthetic({
          sessionID,
          text: `[提醒] 你这一轮没有调用任何发送工具，直接输出的文字会被丢弃。请调用 qq_send_message 工具：想回复就 reply=true 并给出 content，不想回复就 reply=false；发送图片、语音、转发或戳一戳也视为已回复。`,
        })
      } catch (error) {
        this.endBusy(state)
        state.awaitingSend = false
        this.logger.error(`群 ${state.groupId} 发送提醒失败`, error)
      }
    }
  }

  /**
   * 模型执行失败或被中断：idle 钩子不会触发，必须主动释放忙碌状态并处理缓存。
   */
  async handleExecutionEnd(sessionID: string, reason: string): Promise<void> {
    const state = this.sessions.get(sessionID)
    if (!state) return
    this.logger.warn(`群 ${state.groupId} 会话执行结束（${reason}），释放忙碌状态`)
    this.endBusy(state)
    state.current = undefined
    state.awaitingSend = false
    if (state.buffer.length > 0) {
      await this.flushBuffered(sessionID)
    }
  }

  /** 超时看门狗：会话长时间没有 idle 时强制放行缓存。 */
  async recoverGroup(groupId: number): Promise<void> {
    const state = this.groups.get(groupId)
    if (!state?.busy) return
    this.logger.warn(`群 ${groupId} 会话超时未结束，强制放行缓存消息`)
    const buffered = state.buffer
    state.buffer = []
    this.endBusy(state)
    state.current = undefined
    state.awaitingSend = false
    if (buffered.length > 0) {
      await this.dispatch(groupId, state, mergeTurns(buffered))
    }
  }

  /** 检查所有群是否有超过阈值的忙碌会话。 */
  async recoverStale(): Promise<void> {
    for (const state of this.groups.values()) {
      if (!state.busy) continue
      if (Date.now() - state.busySince <= this.config.busyTimeoutMs) continue
      await this.recoverGroup(state.groupId)
    }
  }

  /** 会话真正空闲后，把忙碌期间缓存的消息合并成新的一轮投递。 */
  async flushBuffered(sessionID: string): Promise<void> {
    const state = this.sessions.get(sessionID)
    if (!state) return
    if (state.buffer.length === 0) {
      // 控制类工作（例如手动压缩）不会触发 idle 钩子，但仍会发 session.idle。
      // 这里兜底释放可能残留的忙碌状态。
      this.endBusy(state)
      state.current = undefined
      return
    }

    const turns = state.buffer
    state.buffer = []
    this.endBusy(state)
    state.current = undefined
    this.logger.debug(`群 ${state.groupId} 空闲，合并 ${turns.length} 条缓存消息`)
    await this.dispatch(state.groupId, state, mergeTurns(turns))
  }

  /** 取得（必要时创建）群对应的会话；并发调用复用同一个请求。 */
  ensureSession(groupId: number): Promise<string | undefined> {
    const pending = this.ensureRequests.get(groupId)
    if (pending) return pending
    const request = this.resolveSession(groupId).finally(() => {
      if (this.ensureRequests.get(groupId) === request) this.ensureRequests.delete(groupId)
    })
    this.ensureRequests.set(groupId, request)
    return request
  }

  private async resolveSession(groupId: number): Promise<string | undefined> {
    await this.ensureBindings()
    const state = this.state(groupId)
    if (state.sessionID) {
      if (await this.sessionExists(state.sessionID)) return state.sessionID
      this.unbind(state)
    }

    if (this.config.reuseSession) {
      const reused = await this.findExistingSession(groupId)
      // 会话已经绑给别的群时不能复用，改为新建一个会话。
      if (reused && this.bindSession(state, reused)) {
        this.scheduleSave()
        this.logger.info(`群 ${groupId} 复用已有会话 ${reused}`)
        return reused
      }
    }

    const created = await this.ctx.session.create({
      title: `QQ 群 ${groupId}`,
      ...(this.config.agent ? { agent: this.config.agent } : {}),
      ...(this.config.model ? { model: this.config.model } : {}),
      metadata: { qqGroupId: groupId },
    })
    if (!this.bindSession(state, created.id)) {
      this.logger.error(`群 ${groupId} 新建会话 ${created.id} 已被其他群占用`)
      await this.ctx.session.remove({ sessionID: created.id }).catch((error: unknown) => {
        this.logger.warn(`清理冲突会话 ${created.id} 失败`, error)
      })
      return undefined
    }
    this.scheduleSave()
    this.logger.info(`群 ${groupId} 新建会话 ${created.id}`)
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

  private unbind(state: GroupState): void {
    if (!state.sessionID) return
    this.sessions.delete(state.sessionID)
    this.verifiedSessions.delete(state.sessionID)
    state.sessionID = undefined
    this.scheduleSave()
  }

  /** 绑定会话到群；一个会话只能绑定一个群，已有绑定不能被覆盖。 */
  private bindSession(state: GroupState, sessionID: string): boolean {
    if (state.sessionID && state.sessionID !== sessionID) {
      this.logger.error(
        `群 ${state.groupId} 已绑定会话 ${state.sessionID}，拒绝覆盖为 ${sessionID}`,
      )
      return false
    }
    const owner = this.sessions.get(sessionID)
    if (owner && owner.groupId !== state.groupId) {
      this.logger.error(
        `会话 ${sessionID} 已绑定群 ${owner.groupId}，不能再次绑定群 ${state.groupId}`,
      )
      return false
    }
    state.sessionID = sessionID
    this.sessions.set(sessionID, state)
    return true
  }

  /** 查找带相同群号标记的历史会话，按最近优先分页查找。 */
  private async findExistingSession(groupId: number): Promise<string | undefined> {
    let cursor: SessionListCursor | undefined
    try {
      for (let page = 0; page < 5; page += 1) {
        const result = await this.ctx.session.list({
          directory: this.ctx.location.directory,
          limit: 100,
          order: "desc",
          ...(cursor ? { cursor } : {}),
        })
        const hit = result.data.find((session) => session.metadata?.["qqGroupId"] === groupId)
        if (hit) return hit.id
        cursor = result.cursor.next ?? undefined
        if (!cursor) break
      }
    } catch (error) {
      this.logger.warn(`查找历史会话失败 group=${groupId}`, error)
    }
    return undefined
  }

  /** 该群是否已经建立过会话。 */
  hasSession(groupId: number): boolean {
    return this.groups.get(groupId)?.sessionID !== undefined
  }

  /** 主动说话：向群里对应的会话投递一条合成消息。 */
  async proactive(groupId: number, text: string): Promise<void> {
    const state = this.state(groupId)
    if (state.busy) return
    // 在 await 之前占位，避免用户消息或下一次心跳同时投递。
    this.beginBusy(state)
    state.current = { text, files: [], atMe: true, proactive: true }
    state.awaitingSend = true
    state.reminders = 0
    try {
      const sessionID = await this.ensureSession(groupId)
      if (!sessionID) {
        this.endBusy(state)
        state.current = undefined
        state.awaitingSend = false
        return
      }
      state.lastUserMessageAt = Date.now()
      this.activity[String(groupId)] = state.lastUserMessageAt
      this.scheduleSave()
      await this.ctx.session.synthetic({ sessionID, text })
    } catch (error) {
      this.endBusy(state)
      state.current = undefined
      state.awaitingSend = false
      this.logger.error(`群 ${groupId} 主动说话失败`, error)
    }
  }
}
