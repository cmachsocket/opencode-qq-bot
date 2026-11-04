import { Plugin } from "@opencode/plugin"
import type { GroupMessageEvent } from "@naplink/naplink"
import { resolveConfig, type QQBotConfig } from "./config"
import { createLogger } from "./logger"
import { QQClient } from "./naplink/client"
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
import { registerTools } from "./tools/qq"

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

    if (config.groups.length === 0) {
      logger.warn("未配置目标群号，插件不会响应任何消息（请设置 groups 或 QQ_TARGET_GROUPS）")
    }

    const soulPath = resolveSoulPath(config.soulPath, packageDirectory(), process.cwd())
    const soul = await loadSoul(soulPath)
    if (!soul) logger.warn(`角色设定读取失败：${soulPath ?? "(未找到)"}`)
    const systemPrompt = buildSystemPrompt(soul)

    const client = new QQClient(config.napcat, logger)
    const manager = new SessionManager(ctx, config, logger)
    const toolRegistration = await registerTools({ ctx, config, logger, manager, client })

    // 系统提示：角色设定、当前时间、本轮是否被 @。
    const contextRegistration = await ctx.session.hook("context", (event) => {
      if (manager.groupForSession(event.sessionID) === undefined) return
      event.system.push({ type: "text", text: systemPrompt })
      event.system.push({ type: "text", text: `当前时间：${currentTimeText()}` })
      const turn = manager.currentTurn(event.sessionID)
      event.system.push({
        type: "text",
        text: turn?.atMe ? "你被 @ 了，必须回复。" : "你没有被 @，可以选择不回复。",
      })
    })

    // 会话空闲：冲刷缓存消息，或提醒模型补一次发送。
    const idleRegistration = await ctx.session.hook("experimental.idle", async (event) => {
      await manager.handleIdle(event.sessionID, event.background.length)
    })

    // 真正空闲（含后台任务结束）后，把忙碌期间缓存的消息合并成新的一轮。
    const idleAbort = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.idle"],
          signal: idleAbort.signal,
        })) {
          await manager.flushBuffered(event.data.sessionID)
        }
      } catch (error) {
        if (!idleAbort.signal.aborted) logger.error("订阅会话空闲事件失败", error)
      }
    })()

    const handleMessage = async (event: GroupMessageEvent) => {
      try {
        if (!config.groups.includes(event.group_id)) return
        const selfId = String(event.self_id ?? client.selfId ?? "")
        if (selfId && String(event.user_id) === selfId) return
        if (!shouldProcess(event.message)) return

        await client.hydrate(event.message)
        const renderCtx = { api: client.api, groupId: event.group_id, logger }
        const rendered = await renderMessage(renderCtx, event)
        if (!rendered.text.trim()) return

        const userName = await resolveUserName(renderCtx, String(event.user_id))
        const atMe = mentionsUser(event.message, selfId)

        manager.touch(event.group_id)
        await manager.enqueue(event.group_id, {
          text: `${userName}: ${rendered.text}`,
          files: rendered.files,
          atMe,
        })
      } catch (error) {
        logger.error(`处理群 ${event.group_id} 消息失败`, error)
      }
    }

    // 先注册监听再连接：NapCat 连接期间推送的消息也会被收到。
    client.onGroupMessage((event) => {
      void handleMessage(event)
    })

    await client.connectSafe()

    // 主动说话心跳。
    let timer: ReturnType<typeof setInterval> | undefined
    if (config.proactive.enabled) {
      const tick = async () => {
        const threshold = config.proactive.silenceThresholdSeconds
        for (const groupId of config.groups) {
          if (!manager.hasSession(groupId)) continue
          const silenceHours = (manager.silenceSeconds(groupId) - threshold) / 3600
          if (silenceHours <= 0) continue
          const probability = Math.min(
            1,
            config.proactive.startProbability + config.proactive.probabilityPerHour * silenceHours,
          )
          if (Math.random() >= probability) continue
          logger.info(`群 ${groupId} 沉默 ${silenceHours.toFixed(1)} 小时，主动发起话题`)
          await manager.proactive(groupId, PROACTIVE_HINT)
        }
      }
      timer = setInterval(() => {
        void tick()
      }, config.proactive.tickSeconds * 1000)
    }

    logger.info("插件已加载", {
      groups: config.groups,
      napcat: config.napcat.url,
      agent: config.agent ?? "(默认)",
    })

    return async () => {
      if (timer) clearInterval(timer)
      idleAbort.abort()
      await toolRegistration.dispose()
      await contextRegistration.dispose()
      await idleRegistration.dispose()
      client.dispose()
      logger.info("插件已卸载")
    }
  },
})
