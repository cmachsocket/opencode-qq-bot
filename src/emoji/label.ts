import type { Plugin } from "@opencode/plugin"
import type { Location } from "@opencode/schema"
import { delay, unrefTimer } from "../async"
import type { QQBotConfig } from "../config"
import type { BotHome } from "../home"
import type { Logger } from "../logger"
import { findSession } from "../session/find"
import type { MediaStore } from "../naplink/media"
import type { CustomFace, FavoriteStore } from "./favorites"

/** 标签最长字符数。 */
export const MAX_TAG_LENGTH = 12
/** 单个表情等待模型回复的超时时间。 */
export const LABEL_TIMEOUT_MS = 60_000
/** 插件存储里保存标签会话 ID 的键。 */
export const LABEL_SESSION_KEY = "emoji-label-session"
/** 会话标记：用来找回已经建好的标签会话。 */
export const LABEL_SESSION_MARKER = "qqEmojiLabelSession"

/** 让模型只回一个标签的提示词。 */
export const LABEL_PROMPT = [
  "看这张表情包图片，给它起一个中文名字。",
  `要求：只输出名字本身，一行，最多 ${MAX_TAG_LENGTH} 个字，不要标点、引号、解释或其它文字。`,
  "不要调用任何工具。",
].join("\n")

/**
 * 清理模型给出的标签。
 *
 * 取第一行，去掉列表符号、引号和 markdown 装饰，只保留文字与数字，
 * 最后按码点截断到 12 个字。
 */
export function cleanTag(raw: string): string {
  const line = raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (!line) return ""
  const stripped = line
    .replace(/^[*_~`>]+/, "")
    .replace(/^[-+•·–—]+\s*/, "")
    .replace(/^\d+[.、)）]\s*/, "")
    .replace(/^#+\s*/, "")
    .replace(/[“”"'「」『』‘’`]+/g, "")
  const chars = Array.from(stripped).filter((char) => /[\p{L}\p{N}]/u.test(char))
  return chars.slice(0, MAX_TAG_LENGTH).join("")
}

export interface LabelerDeps {
  ctx: Plugin.Context
  config: QQBotConfig
  /** 机器人固定服务的工作目录，标签会话也建在这里。 */
  home: BotHome
  logger: Logger
  /** 图片下载与落盘。 */
  media: MediaStore
  /** 标签读写。 */
  favorites: FavoriteStore
  /** 单个表情的等待时间。 */
  timeoutMs?: number
}

/**
 * 用模型给收藏表情起名字。
 *
 * 走一个专用的会话：这个会话不绑定任何 QQ 目标，
 * 因此不会触发角色设定里“必须调用 qq_send_message”的守则。
 */
export class EmojiLabeler {
  private readonly abort = new AbortController()
  /** 每个会话当前这一轮累积到的回复文本。 */
  private readonly buffers = new Map<string, string>()
  /** 等待本轮回复结束的回调。 */
  private readonly waiters = new Map<string, ((text: string | undefined) => void)[]>()
  private listener: Promise<void> | undefined
  private sessionID: string | undefined
  private creating: Promise<string> | undefined

  constructor(private readonly deps: LabelerDeps) {}

  /** 标签会话统一落在机器人工作目录，不跟随加载插件的项目目录。 */
  private get location(): Location.PublicRef {
    return { directory: this.deps.home.directory as Location.PublicRef["directory"] }
  }

  /** 标注是否已中止；插件卸载后应停止一切标注动作。 */
  get signal(): AbortSignal {
    return this.abort.signal
  }

  /**
   * 这个会话是不是表情标签会话。
   *
   * 标签会话不绑定任何 QQ 目标，拿不到按聊天的工具限制，而它的输入是一张图片：
   * 图片里的文字同样可能是注入载荷，所以这个会话必须单独把工具全部摘掉。
   */
  async isLabelSession(sessionID: string): Promise<boolean> {
    if (this.sessionID === sessionID) return true
    try {
      const info = await this.deps.ctx.session.get({ sessionID })
      return info?.metadata?.[LABEL_SESSION_MARKER] === true
    } catch {
      return false
    }
  }

  /** 开始订阅文本事件。 */
  start(): void {
    this.listener ??= this.listen()
  }

  /** 停止订阅并清理缓存。 */
  async dispose(): Promise<void> {
    this.abort.abort()
    this.buffers.clear()
    // 唤醒还在等待的标注请求，让它们立刻结束而不是空等到超时。
    for (const waiters of this.waiters.values()) {
      for (const resolve of waiters) resolve(undefined)
    }
    this.waiters.clear()
    await this.listener?.catch(() => {})
    this.listener = undefined
  }

  private async listen(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        for await (const event of this.deps.ctx.event.subscribe({
          // 一轮回复可能拆成多段文本，只有执行结束才知道这一轮说完了。
          types: [
            "session.text.ended",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
          ],
          signal: this.abort.signal,
        })) {
          if (event.type === "session.text.ended") {
            this.push(event.data.sessionID, event.data.text)
          } else if (event.type === "session.execution.succeeded") {
            this.finish(event.data.sessionID)
          } else {
            this.fail(event.data.sessionID)
          }
        }
      } catch (error) {
        if (this.abort.signal.aborted) return
        this.deps.logger.error("订阅表情标签事件失败，稍后重试", error)
      }
      if (this.abort.signal.aborted) return
      await delay(1000)
    }
  }

  /** 累加模型输出的一段文本；一轮回复可能拆成多段。 */
  private push(sessionID: string, text: string): void {
    const buffer = `${this.buffers.get(sessionID) ?? ""}${text}`
    this.buffers.set(sessionID, buffer)
  }

  /** 本轮执行结束：把累积到的完整文本交给等待方。 */
  private finish(sessionID: string): void {
    const waiters = this.waiters.get(sessionID)
    if (!waiters || waiters.length === 0) return
    this.waiters.delete(sessionID)
    const text = this.buffers.get(sessionID) ?? ""
    for (const resolve of waiters) resolve(text)
  }

  /** 本轮执行失败或被中断：没有可用回复。 */
  private fail(sessionID: string): void {
    const waiters = this.waiters.get(sessionID)
    if (!waiters || waiters.length === 0) return
    this.waiters.delete(sessionID)
    for (const resolve of waiters) resolve(undefined)
  }

  /** 等待这一轮的完整回复；超时或执行失败返回 undefined。 */
  private awaitText(sessionID: string, timeoutMs: number): Promise<string | undefined> {
    const buffered = this.buffers.get(sessionID)
    if (buffered && buffered.length > 0) {
      this.buffers.delete(sessionID)
      return Promise.resolve(buffered)
    }
    return new Promise((resolve) => {
      const onText = (text: string | undefined) => {
        clearTimeout(timer)
        resolve(text)
      }
      const timer = setTimeout(() => {
        const waiters = this.waiters.get(sessionID) ?? []
        this.waiters.set(
          sessionID,
          waiters.filter((item) => item !== onText),
        )
        resolve(undefined)
      }, timeoutMs)
      unrefTimer(timer)
      const waiters = this.waiters.get(sessionID) ?? []
      waiters.push(onText)
      this.waiters.set(sessionID, waiters)
    })
  }

  /** 取得（必要时创建）专用的标签会话。 */
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
      return stored
    }
    const found = await this.findLabelSession()
    if (found) {
      this.sessionID = found
      await this.writeStoredSession(found)
      this.deps.logger.info(`复用表情标签会话 ${found}`)
      return found
    }
    const created = await this.deps.ctx.session.create({
      title: "收藏表情标签",
      location: this.location,
      ...(this.deps.config.agent ? { agent: this.deps.config.agent } : {}),
      ...(this.deps.config.model ? { model: this.deps.config.model } : {}),
      metadata: { [LABEL_SESSION_MARKER]: true },
    })
    this.sessionID = created.id
    await this.writeStoredSession(created.id)
    this.deps.logger.info(`新建表情标签会话 ${created.id}`)
    return created.id
  }

  private async readStoredSession(): Promise<string | undefined> {
    try {
      const stored = await this.deps.ctx.storage.get(LABEL_SESSION_KEY)
      if (typeof stored !== "string" || stored.length === 0) return undefined
      const info = await this.deps.ctx.session.get({ sessionID: stored })
      if (info?.location?.directory !== this.location.directory) {
        this.deps.logger.debug(`存储里的标签会话 ${stored} 不在机器人工作目录，忽略`)
        return undefined
      }
      return info?.id ?? stored
    } catch (error) {
      this.deps.logger.debug("读取收藏表情标签会话失败，将新建会话", error)
      return undefined
    }
  }

  private async writeStoredSession(sessionID: string): Promise<void> {
    try {
      await this.deps.ctx.storage.set(LABEL_SESSION_KEY, sessionID)
    } catch (error) {
      this.deps.logger.warn("保存收藏表情标签会话失败", error)
    }
  }

  /** 查找带标签标记的历史会话。 */
  private async findLabelSession(): Promise<string | undefined> {
    return await findSession(
      this.deps.ctx,
      this.location.directory,
      (session) => session.metadata?.[LABEL_SESSION_MARKER] === true,
      this.deps.logger,
      "查找收藏表情标签会话失败",
    )
  }

  /**
   * 给一个表情生成标签并写回 NapCat。
   *
   * 返回写进去的标签；下载失败、模型没给出可用名字或写入失败时返回 undefined。
   */
  async labelFace(face: CustomFace): Promise<string | undefined> {
    // 插件卸载后不再发起新的标注请求。
    if (this.abort.signal.aborted) return undefined
    const url = typeof face.url === "string" ? face.url : undefined
    if (!url) return undefined
    const stored = await this.deps.media.storeImage(url)
    if (!stored) {
      this.deps.logger.warn("收藏表情图片下载失败，跳过标注")
      return undefined
    }
    this.start()
    const sessionID = await this.ensureSession()
    // 丢掉上一轮的残留文本，保证拿到的是这次提问的回复。
    this.buffers.delete(sessionID)
    try {
      await this.deps.ctx.session.prompt({
        sessionID,
        text: LABEL_PROMPT,
        files: [
          {
            uri: stored.uri,
            name: stored.name,
            ...(stored.source ? { source: stored.source } : {}),
          },
        ],
      })
    } catch (error) {
      this.deps.logger.error("投递表情标签请求失败", error)
      return undefined
    }
    const raw = await this.awaitText(sessionID, this.deps.timeoutMs ?? LABEL_TIMEOUT_MS)
    // 等回复期间插件可能已经卸载，此时不再写标签。
    if (this.abort.signal.aborted) return undefined
    const tag = cleanTag(raw ?? "")
    if (!tag) {
      this.deps.logger.warn("模型没有给出可用的表情标签")
      return undefined
    }
    const written = await this.deps.favorites.setTag(face, tag)
    if (!written) return undefined
    return tag
  }
}
