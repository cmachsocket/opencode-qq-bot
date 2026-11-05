import { Plugin } from "@opencode/plugin"
import type { GroupMessageEvent, MessageEvent } from "@naplink/naplink"
import { Mutex } from "async-mutex"
import { type ChatTarget, configuredTargets, isTargetEnabled, targetKey, targetLabel } from "./chat"
import { resolveConfig, type QQBotConfig } from "./config"
import { claimInstance } from "./instance"
import { createLogger } from "./logger"
import { QQClient } from "./naplink/client"
import { createMediaStore } from "./naplink/media"
import { mentionsUser, renderMessage, resolveUserName, shouldProcess } from "./naplink/render"
import { RESUME_INTERVAL_MS, SessionManager } from "./session/manager"
import { currentTimeText, PROACTIVE_HINT } from "./session/prompt"
import { proactiveTickProbability } from "./session/proactive"
import { packageDirectory, SoulStore } from "./session/soul"
import { registerAskGuard } from "./tools/ask-guard"
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

    // 角色设定：读取生效文件并监听改动，改完下一轮即生效。
    const soul = new SoulStore(
      {
        soulPath: config.soulPath,
        soulName: config.soulName,
        moduleDir: packageDirectory(),
        cwd: process.cwd(),
      },
      logger,
    )
    await soul.load()

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
    // QQ 会话里禁止模型调用内置 question 工具，改用 qq_send_message 询问用户。
    const askGuardRegistration = await registerAskGuard({ ctx, logger, manager })
    const nameCache = new Map<string, { name: string; expires: number }>()

    // 系统提示：角色设定、当前时间、本轮是否必须回复。
    const contextRegistration = await ctx.session.hook("context", (event) => {
      const target = manager.targetForSession(event.sessionID)
      if (target === undefined) return
      event.system.push({ type: "text", text: soul.prompt })
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

    // 会话空闲后，把队列里缓存的消息合并成新的一轮。
    // `session.status` 是官方推荐的状态信号；2.2.5 实际只在执行结束时发
    // `session.execution.succeeded`，所以两者都要监听。失败或中断单独结束轮次。
    // 订阅断掉后自动重连。
    const idleAbort = new AbortController()
    void (async () => {
      while (!idleAbort.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({
            types: [
              "session.status",
              "session.execution.succeeded",
              "session.execution.failed",
              "session.execution.interrupted",
            ],
            signal: idleAbort.signal,
          })) {
            if (event.type === "session.status") {
              if (event.data.status.type === "idle") {
                await manager.flushBuffered(event.data.sessionID)
              }
            } else if (event.type === "session.execution.succeeded") {
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
    const processing = new Map<string, Mutex>()
    const processingMutex = (key: string): Mutex => {
      let mutex = processing.get(key)
      if (!mutex) {
        mutex = new Mutex()
        processing.set(key, mutex)
      }
      return mutex
    }
    const scheduleMessage = (event: MessageEvent) => {
      const target = eventTarget(event)
      if (!isTargetEnabled(config, target)) return
      const selfId = String(event.self_id ?? client.selfId ?? "")
      if (selfId && String(event.user_id) === selfId) return

      if (!manager.rememberIncoming(target, String(event.message_id))) {
        logger.debug(`忽略重复消息 ${event.message_id}`)
        return
      }
      manager.touch(target)

      void processingMutex(targetKey(target))
        .runExclusive(() => handleMessage(event, target, selfId))
        .catch((error: unknown) => logger.error(`处理 ${targetLabel(target)} 消息失败`, error))
    }

    // 先注册监听再连接：NapCat 连接期间推送的消息也会被收到。
    client.onGroupMessage(scheduleMessage)
    client.onPrivateMessage(scheduleMessage)

    await client.connectSafe()

    // 主动说话心跳。
    let timer: ReturnType<typeof setInterval> | undefined
    if (config.proactive.enabled) {
      const tickMutex = new Mutex()
      const tick = async () => {
        if (tickMutex.isLocked()) return
        await tickMutex.runExclusive(async () => {
          for (const target of configuredTargets(config)) {
            const probability = proactiveTickProbability(
              config.proactive,
              manager.silenceSeconds(target),
            )
            if (probability <= 0 || Math.random() >= probability) continue
            logger.info(`${targetLabel(target)} 沉默达到阈值，主动发起话题`)
            await manager.proactive(target, PROACTIVE_HINT)
          }
        })
      }
      timer = setInterval(() => {
        void tick().catch((error: unknown) => logger.error("主动说话心跳失败", error))
      }, config.proactive.tickSeconds * 1000)
      const handle = timer as { unref?: () => void }
      handle.unref?.()
    }

    // 执行结束事件丢失时，用上游会话状态兜底放行缓存；不会打断仍在运行的轮次。
    const resumeTimer = setInterval(() => {
      void manager.resumeBuffered()
    }, RESUME_INTERVAL_MS)
    const resumeHandle = resumeTimer as { unref?: () => void }
    resumeHandle.unref?.()

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
      clearInterval(resumeTimer)
      clearInterval(mediaCleanup)
      idleAbort.abort()
      await manager.flush()
      soul.dispose()
      await toolRegistration.dispose()
      await askGuardRegistration.dispose()
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
