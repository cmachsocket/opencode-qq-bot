import type { Plugin } from "@opencode/plugin"
import { unrefTimer } from "./async"
import type { QQBotConfig } from "./config"
import type { Logger } from "./logger"
import { findSession } from "./session/find"

/** 插件存储里保存保活会话 ID 的键。 */
export const KEEP_ALIVE_SESSION_KEY = "keepalive-session"
/** 会话标记：用来找回已经建好的保活会话。 */
export const KEEP_ALIVE_SESSION_MARKER = "qqKeepAliveSession"
/** 保活会话标题。 */
export const KEEP_ALIVE_TITLE = "QQ 保活"
/** 上游表示“会话不存在”的错误名。 */
const SESSION_NOT_FOUND = "Session.NotFoundError"

/**
 * 判断错误是不是上游的“会话不存在”。
 *
 * 上游的 Session.NotFoundError 没有 message，只有 name 和 _tag，
 * 所以只能靠名字判断，不然日志里只剩一段没有内容的栈。
 */
function isSessionNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const candidate = error as { name?: unknown; _tag?: unknown }
  return candidate.name === SESSION_NOT_FOUND || candidate._tag === SESSION_NOT_FOUND
}

/**
 * 保活心跳：让 OpenCode 不要因为长时间没有会话活动而卸载插件。
 *
 * OpenCode 按 location 统计会话活动，默认空闲 60 分钟后卸载该 location 的服务，
 * 插件随之被卸载，NapCat 连接断开后机器人就不再响应。
 * 写回一次会话元数据会发布 durable 的 `session.metadata.updated` 事件，
 * 事件带着插件所在 location，于是该 location 的空闲计时被重置。
 */
export class KeepAlive {
  private timer: ReturnType<typeof setInterval> | undefined
  private sessionID: string | undefined
  private creating: Promise<string> | undefined
  private stopped = false

  constructor(
    private readonly ctx: Plugin.Context,
    private readonly config: QQBotConfig,
    private readonly logger: Logger,
  ) {}

  /** 启动保活心跳。 */
  start(): void {
    if (this.timer || !this.config.keepAlive.enabled) return
    void this.ping()
    this.timer = setInterval(() => {
      void this.ping()
    }, this.config.keepAlive.seconds * 1000)
    unrefTimer(this.timer)
  }

  /**
   * 停止保活心跳，并删掉保活会话。
   *
   * 会话只服务于保活，插件卸载后留着它只会在项目目录里留下垃圾，
   * 所以卸载时顺手删掉，存储里的记录也一起清掉。
   */
  async dispose(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    const sessionID = this.sessionID
    this.sessionID = undefined
    if (!sessionID) return
    try {
      await this.ctx.session.remove({ sessionID })
      this.logger.info(`保活会话 ${sessionID} 已删除`)
    } catch (error) {
      this.logger.warn("删除保活会话失败", error)
    }
    await this.clearStoredSession(sessionID)
  }

  /**
   * 写回一次会话元数据，刷新 location 的空闲计时。
   *
   * 元数据是整体替换的，所以先读出当前值再原样写回。
   */
  async ping(): Promise<void> {
    if (this.stopped) return
    let sessionID: string
    try {
      sessionID = await this.ensureSession()
    } catch (error) {
      this.logger.warn("保活心跳失败：取不到保活会话", error)
      return
    }
    if (this.stopped) return

    let metadata: NonNullable<Parameters<Plugin.Context["session"]["update"]>[0]["metadata"]>
    try {
      const info = await this.ctx.session.get({ sessionID })
      metadata = info?.metadata ?? { [KEEP_ALIVE_SESSION_MARKER]: true }
    } catch (error) {
      if (isSessionNotFound(error)) {
        // 会话已经被删掉了：当场重建，不等下一个心跳。
        this.logger.warn(`保活会话 ${sessionID} 已不存在，正在重建`)
        await this.rebuild(sessionID)
        return
      }
      // 会话暂时读不出来：丢掉缓存，下一次心跳重建一个。
      this.logger.warn("保活会话已失效，将重建", error)
      this.sessionID = undefined
      return
    }

    try {
      await this.ctx.session.update({ sessionID, metadata })
      this.logger.debug(`保活心跳已刷新会话 ${sessionID}`)
    } catch (error) {
      if (isSessionNotFound(error)) {
        this.logger.warn(`保活会话 ${sessionID} 已不存在，正在重建`)
        await this.rebuild(sessionID)
        return
      }
      this.logger.warn("保活心跳失败", error)
    }
  }

  /**
   * 保活会话已经不存在时的重建。
   *
   * 不当场重建的话要等到下一个心跳才补上，这段时间里插件可能被 OpenCode 当成空闲卸载，
   * 保活也就失效了，所以当场重建并刷新一次元数据。
   */
  private async rebuild(staleSessionID: string): Promise<void> {
    this.sessionID = undefined
    await this.clearStoredSession(staleSessionID)
    try {
      const sessionID = await this.resolveSession()
      if (this.stopped) return
      const info = await this.ctx.session.get({ sessionID })
      await this.ctx.session.update({
        sessionID,
        metadata: info?.metadata ?? { [KEEP_ALIVE_SESSION_MARKER]: true },
      })
      this.logger.debug(`保活心跳已刷新会话 ${sessionID}`)
    } catch (error) {
      this.logger.warn("重建保活会话失败", error)
    }
  }

  /** 取得（必要时创建）保活会话；并发调用串行执行，避免重复建会话。 */
  private async ensureSession(): Promise<string> {
    if (this.sessionID) return this.sessionID
    this.creating ??= this.resolveSession().finally(() => {
      this.creating = undefined
    })
    return this.creating
  }

  private async resolveSession(): Promise<string> {
    const stored = await this.readStoredSession()
    if (stored) {
      this.sessionID = stored
      await this.ensureArchived(stored)
      return stored
    }
    const found = await this.findKeepAliveSession()
    if (found) {
      this.sessionID = found
      await this.writeStoredSession(found)
      await this.ensureArchived(found)
      this.logger.info(`复用保活会话 ${found}`)
      return found
    }
    const created = await this.ctx.session.create({
      title: KEEP_ALIVE_TITLE,
      metadata: { [KEEP_ALIVE_SESSION_MARKER]: true },
    })
    this.sessionID = created.id
    await this.writeStoredSession(created.id)
    await this.ensureArchived(created.id)
    this.logger.info(`新建保活会话 ${created.id}`)
    return created.id
  }

  /**
   * 归档保活会话，让它不出现在会话列表里。
   *
   * 上游的插件接口目前只处理 title/metadata/permissions，archived 会被忽略，
   * 所以调用之后要再读一次，确认到底有没有归档成功。
   */
  private async ensureArchived(sessionID: string): Promise<void> {
    try {
      await this.ctx.session.update({ sessionID, archived: true })
    } catch (error) {
      if (isSessionNotFound(error)) {
        this.logger.debug(`保活会话 ${sessionID} 已不存在，跳过归档`)
        return
      }
      this.logger.debug("归档保活会话失败", error)
      return
    }
    try {
      const info = await this.ctx.session.get({ sessionID })
      if (info?.time?.archived !== undefined) {
        this.logger.info(`保活会话 ${sessionID} 已归档`)
      } else {
        this.logger.info(`上游未支持归档保活会话 ${sessionID}，它会显示在会话列表里`)
      }
    } catch (error) {
      this.logger.debug("确认保活会话归档状态失败", error)
    }
  }

  /** 读取上次保存的保活会话；会话已经不存在或属于别的目录时返回 undefined。 */
  private async readStoredSession(): Promise<string | undefined> {
    let stored: unknown
    try {
      stored = await this.ctx.storage.get(KEEP_ALIVE_SESSION_KEY)
      if (typeof stored !== "string" || stored.length === 0) return undefined
      const info = await this.ctx.session.get({ sessionID: stored })
      // 插件存储是机器级共享的，别的目录留下的会话不能拿来用。
      if (info?.location?.directory !== this.ctx.location.directory) {
        this.logger.debug(`存储里的保活会话 ${stored} 不在当前目录，忽略`)
        return undefined
      }
      return stored
    } catch (error) {
      if (isSessionNotFound(error)) {
        this.logger.debug(`存储里的保活会话 ${String(stored)} 已不存在，将新建会话`)
        await this.clearStoredSession(String(stored))
        return undefined
      }
      this.logger.debug("读取保活会话失败，将新建会话", error)
      return undefined
    }
  }

  /** 查找带保活标记的历史会话。 */
  private async findKeepAliveSession(): Promise<string | undefined> {
    return await findSession(
      this.ctx,
      this.ctx.location.directory,
      (session) => session.metadata?.[KEEP_ALIVE_SESSION_MARKER] === true,
      this.logger,
      "查找保活会话失败",
    )
  }

  private async writeStoredSession(sessionID: string): Promise<void> {
    try {
      await this.ctx.storage.set(KEEP_ALIVE_SESSION_KEY, sessionID)
    } catch (error) {
      this.logger.warn("保存保活会话失败", error)
    }
  }

  /** 清掉存储里的会话记录；记录已经被别的项目改写时不动它。 */
  private async clearStoredSession(sessionID: string): Promise<void> {
    try {
      const stored = await this.ctx.storage.get(KEEP_ALIVE_SESSION_KEY)
      if (stored !== sessionID) return
      await this.ctx.storage.remove(KEEP_ALIVE_SESSION_KEY)
    } catch (error) {
      this.logger.warn("清除保活会话记录失败", error)
    }
  }
}
