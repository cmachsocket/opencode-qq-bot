import { Plugin } from "@opencode/plugin"
import type { GroupMessageEvent, MessageEvent } from "@naplink/naplink"
import { type ChatTarget, configuredTargets, isTargetEnabled, targetKey, targetLabel } from "./chat"
import { resolveConfig, type QQBotConfig } from "./config"
import { claimInstance } from "./instance"
import { createLogger } from "./logger"
import { QQClient } from "./naplink/client"
import { createMediaStore } from "./naplink/media"
import { mentionsUser, renderMessage, resolveUserName, shouldProcess } from "./naplink/render"
import { SessionManager } from "./session/manager"
import {
  buildSystemPrompt,
  currentTimeText,
  loadSoul,
  PROACTIVE_HINT,
  resolveSoulPath,
  packageDirectory,
} from "./session/prompt"
import { proactiveTickProbability } from "./session/proactive"
import { registerTools } from "./tools/qq"

const RETRY_DELAY_MS = 1000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default Plugin.define({
  id: "opencode-qq-bot",
  async setup(ctx) {
    const logger = createLogger("[qq-bot]")
    let config: QQBotConfig
    try {
      config = resolveConfig(ctx.options, process.env, (message) => logger.warn(message))
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error))
      return
    }

    if (config.groups.length === 0 && config.users.length === 0) {
      logger.warn(
        "未配置目标群号或私聊 QQ 号，插件不会响应任何消息（请设置 groups/users 或 QQ_TARGET_GROUPS/QQ_TARGET_USERS）",
      )
    }

    // OpenCode 重新加载插件时未必调用旧的清理函数，接管同一连接的单例并主动卸载旧实例。
    const { previous, lease } = claimInstance(`${ctx.location.directory}\n${config.napcat.url}`)
    if (previous?.dispose) {
      try {
        await previous.dispose()
      } catch (error) {
        logger.error("卸载旧插件实例失败", error)
      }
    }

    const soulPath = resolveSoulPath(config.soulPath, packageDirectory(), process.cwd())
    const soul = await loadSoul(soulPath)
    if (!soul) logger.warn(`角色设定读取失败：${soulPath ?? "(未找到)"}`)
    const systemPrompt = buildSystemPrompt(soul)

    const client = new QQClient(config.napcat, logger)
    const manager = new SessionManager(ctx, config, logger)
    await manager.load()
    const media = await createMediaStore(logger)
    const mediaCleanup = setInterval(
      () => {
        void media.cleanup()
      },
      60 * 60 * 1000,
    )
    const mediaHandle = mediaCleanup as { unref?: () => void }
    mediaHandle.unref?.()
    const toolRegistration = await registerTools({ ctx, config, logger, manager, client })
    const nameCache = new Map<string, { name: string; expires: number }>()

    // 系统提示：角色设定、当前时间、本轮是否必须回复。
    const contextRegistration = await ctx.session.hook("context", (event) => {
      const target = manager.targetForSession(event.sessionID)
      if (target === undefined) return
      event.system.push({ type: "text", text: systemPrompt })
      event.system.push({ type: "text", text: `当前时间：${currentTimeText()}` })
      const turn = manager.currentTurn(event.sessionID)
      const destination = target.kind === "group" ? "群里" : "私聊里"
      event.system.push({
        type: "text",
        text: turn?.proactive
          ? `这是一次主动发起话题，必须调用 qq_send_message 把话题发到${destination}。`
          : turn?.atMe
            ? target.kind === "private"
              ? "这是一条私聊消息，必须回复。"
              : "你被 @ 了，必须回复。"
            : "你没有被 @，可以选择不回复。",
      })
    })

    // 会话空闲：冲刷缓存消息，或提醒模型补一次发送。
    const idleRegistration = await ctx.session.hook("experimental.idle", async (event) => {
      await manager.handleIdle(event.sessionID, event.background)
    })

    // 真正空闲（含后台任务结束）后，把忙碌期间缓存的消息合并成新的一轮。
    // 失败或中断不会触发 idle 钩子，也要在这里释放状态；订阅断掉后自动重连。
    const idleAbort = new AbortController()
    void (async () => {
      while (!idleAbort.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({
            types: ["session.idle", "session.execution.failed", "session.execution.interrupted"],
            signal: idleAbort.signal,
          })) {
            if (event.type === "session.idle") {
              await manager.flushBuffered(event.data.sessionID)
            } else {
              await manager.handleExecutionEnd(event.data.sessionID, event.type)
            }
          }
        } catch (error) {
          if (idleAbort.signal.aborted) break
          logger.error("订阅会话事件失败，稍后重试", error)
        }
        if (!idleAbort.signal.aborted) await delay(RETRY_DELAY_MS)
      }
    })()

    const isGroupEvent = (event: MessageEvent): event is GroupMessageEvent =>
      event.message_type === "group"

    const eventTarget = (event: MessageEvent): ChatTarget =>
      isGroupEvent(event)
        ? { kind: "group", id: event.group_id }
        : { kind: "private", id: event.user_id }

    const handleMessage = async (event: MessageEvent, target: ChatTarget, selfId: string) => {
      try {
        if (!isTargetEnabled(config, target)) return
        if (!shouldProcess(event.message, selfId)) return

        await client.hydrate(event.message)
        const renderCtx = {
          api: client.api,
          target,
          logger,
          media,
          names: nameCache,
        }
        const rendered = await renderMessage(renderCtx, event)
        if (!rendered.text.trim()) return

        const userName = await resolveUserName(renderCtx, String(event.user_id))
        // 私聊消息默认都是对机器人说的，群聊只有被 @ 时才必须回复。
        const atMe = target.kind === "private" || mentionsUser(event.message, selfId)

        await manager.enqueue(target, {
          text: `${userName}: ${rendered.text}`,
          files: rendered.files,
          atMe,
        })
      } catch (error) {
        logger.error(`处理 ${targetLabel(target)} 消息失败`, error)
      }
    }

    // 同一会话内串行处理，避免图片下载、成员查询等异步操作打乱消息顺序。
    const processing = new Map<string, Promise<void>>()
    const scheduleMessage = (event: MessageEvent) => {
      const target = eventTarget(event)
      if (!isTargetEnabled(config, target)) return
      const selfId = String(event.self_id ?? client.selfId ?? "")
      if (selfId && String(event.user_id) === selfId) return

      manager.touch(target)
      manager.rememberIncoming(target, String(event.message_id))

      const key = targetKey(target)
      const previous = processing.get(key) ?? Promise.resolve()
      const task = previous
        .then(() => handleMessage(event, target, selfId))
        .catch((error: unknown) => logger.error(`处理 ${targetLabel(target)} 消息失败`, error))
      processing.set(key, task)
      void task.finally(() => {
        if (processing.get(key) === task) processing.delete(key)
      })
    }

    // 先注册监听再连接：NapCat 连接期间推送的消息也会被收到。
    client.onGroupMessage(scheduleMessage)
    client.onPrivateMessage(scheduleMessage)

    await client.connectSafe()

    // 主动说话心跳。
    let timer: ReturnType<typeof setInterval> | undefined
    let ticking = false
    if (config.proactive.enabled) {
      const tick = async () => {
        if (ticking) return
        ticking = true
        try {
          await manager.recoverStale()
          for (const target of configuredTargets(config)) {
            const probability = proactiveTickProbability(
              config.proactive,
              manager.silenceSeconds(target),
            )
            if (probability <= 0 || Math.random() >= probability) continue
            logger.info(`${targetLabel(target)} 沉默达到阈值，主动发起话题`)
            await manager.proactive(target, PROACTIVE_HINT)
          }
        } finally {
          ticking = false
        }
      }
      timer = setInterval(() => {
        void tick()
      }, config.proactive.tickSeconds * 1000)
      const handle = timer as { unref?: () => void }
      handle.unref?.()
    }

    logger.info("插件已加载", {
      groups: config.groups,
      users: config.users,
      napcat: config.napcat.url,
      agent: config.agent ?? "(默认)",
    })

    let disposed = false
    const dispose = async () => {
      if (disposed) return
      disposed = true
      if (timer) clearInterval(timer)
      clearInterval(mediaCleanup)
      idleAbort.abort()
      await manager.flush()
      await toolRegistration.dispose()
      await contextRegistration.dispose()
      await idleRegistration.dispose()
      client.dispose()
      lease.release()
      logger.info("插件已卸载")
    }
    lease.setDispose(dispose)
    return dispose
  },
})
