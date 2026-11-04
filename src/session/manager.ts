import type { Plugin } from "@opencode/plugin"
import type { QQBotConfig } from "../config"
import type { Logger } from "../logger"
import { limitFiles, type PromptFile } from "../naplink/render"

/** 插件存储里保存群与会话绑定的键。 */
const BINDINGS_KEY = "bindings"

export interface Turn {
  /** 交给模型的文本。 */
  text: string
  /** 图片附件。 */
  files: PromptFile[]
  /** 本轮是否 @ 了机器人。 */
  atMe: boolean
}

interface GroupState {
  groupId: number
  sessionID?: string
  /** 会话是否正在跑模型（收到消息到 idle 之间）。 */
  busy: boolean
  /** 进入忙碌状态的时间戳（毫秒），用于识别卡死的会话。 */
  busySince: number
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

export function mergeTurns(turns: readonly Turn[]): Turn {
  return {
    text: turns
      .map((turn) => turn.text.trim())
      .filter((text) => text.length > 0)
      .join("\n"),
    files: limitFiles(turns.flatMap((turn) => turn.files)),
    atMe: turns.some((turn) => turn.atMe),
  }
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
      return
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return

    let restored = 0
    for (const [key, value] of Object.entries(stored)) {
      const groupId = Number(key)
      if (!Number.isInteger(groupId) || typeof value !== "string" || value.length === 0) continue
      if (!this.bindSession(this.state(groupId), value)) continue
      restored += 1
    }
    if (restored > 0) this.logger.debug(`已恢复 ${restored} 个群的会话绑定`)
  }

  /** 绑定变化后写回插件存储，串行执行避免互相覆盖。 */
  private scheduleSave(): void {
    this.saveQueue = this.saveQueue.then(() => this.writeBindings())
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
        lastUserMessageAt: Date.now(),
      }
      this.groups.set(groupId, state)
    }
    return state
  }

  /** 会话 ID 反查群号。 */
  groupForSession(sessionID: string): number | undefined {
    return this.sessions.get(sessionID)?.groupId
  }

  /** 当前轮次的消息。 */
  currentTurn(sessionID: string): Turn | undefined {
    return this.sessions.get(sessionID)?.current
  }

  /** 标记模型已经调用过发送工具。 */
  markMessageSent(sessionID: string): void {
    const state = this.sessions.get(sessionID)
    if (!state) return
    state.awaitingSend = false
    state.reminders = 0
  }

  /** 记录一次真实用户消息的时间。 */
  touch(groupId: number): void {
    this.state(groupId).lastUserMessageAt = Date.now()
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
      // 会话异常中断时 idle 回调不会触发，超过超时阈值就当卡死处理。
      if (Date.now() - state.busySince <= this.config.busyTimeoutMs) {
        state.buffer.push(turn)
        this.logger.debug(`群 ${groupId} 忙碌中，消息已缓存（累计 ${state.buffer.length} 条）`)
        return
      }
      this.logger.warn(`群 ${groupId} 会话超时未结束，强制放行缓存消息`)
      state.busy = false
      state.busySince = 0
      state.current = undefined
      const buffered = state.buffer
      state.buffer = []
      await this.dispatch(groupId, state, mergeTurns([...buffered, turn]))
      return
    }
    await this.dispatch(groupId, state, turn)
  }

  /** 把一轮消息投进 OpenCode 会话。 */
  private async dispatch(groupId: number, state: GroupState, turn: Turn): Promise<void> {
    if (state.busy) return
    // 先同步占位，避免并发消息重复投递
    state.busy = true
    state.busySince = Date.now()
    state.current = turn
    state.awaitingSend = true
    // 新的用户轮次重新给一份提醒预算，否则连续几轮不调工具就再也提醒不了。
    state.reminders = 0
    try {
      const sessionID = await this.ensureSession(groupId)
      if (!sessionID) {
        state.busy = false
        state.busySince = 0
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
      state.busy = false
      state.busySince = 0
      state.current = undefined
      state.awaitingSend = false
      this.logger.error(`群 ${groupId} 投递消息失败`, error)
    }
  }

  /**
   * 会话即将空闲：若有缓存消息，保持忙碌等 session.idle 后再投递；
   * 否则清掉忙碌标记，若模型这一轮没调用发送工具则提醒它补一次。
   *
   * `background` 是仍在运行的后台任务数；后台任务还在跑时会话并没有真正空闲，
   * 这时保持忙碌标记，等真正空闲（后台任务结束后再次触发 idle）再处理，
   * 否则新消息会被立刻投进正在执行的会话，打乱消息顺序。
   */
  async handleIdle(sessionID: string, background = 0): Promise<void> {
    const state = this.sessions.get(sessionID)
    if (!state) return

    if (background > 0) {
      this.logger.debug(`群 ${state.groupId} 仍有后台任务，保持忙碌状态`)
      return
    }

    if (state.buffer.length > 0) {
      // 在 idle 钩子里投递会被并入旧的一轮；保持忙碌，等真正空闲后再开始新一轮。
      this.logger.debug(`群 ${state.groupId} 空闲，等待投递 ${state.buffer.length} 条缓存消息`)
      return
    }

    state.busy = false
    state.busySince = 0
    state.current = undefined

    if (
      state.awaitingSend &&
      this.config.reminder.enabled &&
      state.reminders < this.config.reminder.max
    ) {
      state.reminders += 1
      // 合成消息会唤醒会话再跑一轮，先占位避免新消息插队。
      state.busy = true
      state.busySince = Date.now()
      this.logger.warn(`群 ${state.groupId} 模型未调用发送工具，提醒第 ${state.reminders} 次`)
      try {
        await this.ctx.session.synthetic({
          sessionID,
          text: `[提醒] 你这一轮没有调用 ${"qq_send_message"} 工具，直接输出的文字会被丢弃。请调用 qq_send_message 工具：想回复就 reply=true 并给出 content，不想回复就 reply=false。`,
        })
      } catch (error) {
        state.busy = false
        state.busySince = 0
        this.logger.error(`群 ${state.groupId} 发送提醒失败`, error)
      }
    }
  }

  /** 会话真正空闲后，把忙碌期间缓存的消息合并成新的一轮投递。 */
  async flushBuffered(sessionID: string): Promise<void> {
    const state = this.sessions.get(sessionID)
    if (!state || state.buffer.length === 0) return

    const turns = state.buffer
    state.buffer = []
    state.busy = false
    state.busySince = 0
    state.current = undefined
    this.logger.debug(`群 ${state.groupId} 空闲，合并 ${turns.length} 条缓存消息`)
    await this.dispatch(state.groupId, state, mergeTurns(turns))
  }

  /** 取得（必要时创建）群对应的会话。 */
  async ensureSession(groupId: number): Promise<string | undefined> {
    await this.ensureBindings()
    const state = this.state(groupId)
    if (state.sessionID) return state.sessionID

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
      return undefined
    }
    this.scheduleSave()
    this.logger.info(`群 ${groupId} 新建会话 ${created.id}`)
    return created.id
  }

  /** 绑定会话到群；一个会话只能绑定一个群。 */
  private bindSession(state: GroupState, sessionID: string): boolean {
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

  /** 查找带相同群号标记的历史会话。 */
  private async findExistingSession(groupId: number): Promise<string | undefined> {
    try {
      const page = await this.ctx.session.list({
        directory: this.ctx.location.directory,
        limit: 100,
      })
      const hit = page.data.find((session) => session.metadata?.["qqGroupId"] === groupId)
      return hit?.id
    } catch (error) {
      this.logger.warn(`查找历史会话失败 group=${groupId}`, error)
      return undefined
    }
  }

  /** 该群是否已经建立过会话（主动说话需要历史上下文）。 */
  hasSession(groupId: number): boolean {
    return this.groups.get(groupId)?.sessionID !== undefined
  }

  /** 主动说话：向群里对应的会话投递一条合成消息。 */
  async proactive(groupId: number, text: string): Promise<void> {
    const state = this.state(groupId)
    if (state.busy) return
    const sessionID = await this.ensureSession(groupId)
    if (!sessionID) return
    state.busy = true
    state.busySince = Date.now()
    state.current = { text, files: [], atMe: false }
    state.awaitingSend = true
    try {
      await this.ctx.session.synthetic({ sessionID, text })
    } catch (error) {
      state.busy = false
      state.busySince = 0
      state.current = undefined
      state.awaitingSend = false
      this.logger.error(`群 ${groupId} 主动说话失败`, error)
    }
  }
}
