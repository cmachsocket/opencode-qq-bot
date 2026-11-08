import { Plugin } from "@opencode/plugin"
import type { GroupMessageEvent, MessageEvent } from "@naplink/naplink"
import { Mutex } from "async-mutex"
import { acquireBotLock, type BotLock, botLockPath } from "./bot-lock"
import { type ChatTarget, configuredTargets, isTargetEnabled, targetKey, targetLabel } from "./chat"
import { resolveConfig, type QQBotConfig } from "./config"
import { resolveHome } from "./home"
import { claimInstance } from "./instance"
import { KeepAlive } from "./keepalive"
import { createLogger, closeLogger, flushLogger } from "./logger"
import { defaultMediaDir, OutboundMedia } from "./media-path"
import { formatModelMessage } from "./model-view"
import { QQClient } from "./naplink/client"
import { createHistoryProvider } from "./naplink/history"
import { createMediaStore } from "./naplink/media"
import { mentionsUser, renderMessage, resolveUserName, shouldProcess } from "./naplink/render"
import { SendRateLimiter } from "./rate-limit"
import { collectEnvSecrets, SensitiveChecker } from "./sensitive"
import { SessionManager } from "./session/manager"
import { currentTimeText, PROACTIVE_HINT } from "./session/prompt"
import { proactiveTickProbability } from "./session/proactive"
import { packageDirectory, SoulStore } from "./session/soul"
import { registerAskGuard } from "./tools/ask-guard"
import { registerSendGuard } from "./tools/send-guard"
import { registerTools } from "./tools/qq"
import { registerEmojiCommand } from "./emoji/command"
import { FavoriteStore } from "./emoji/favorites"
import { FavoriteIndex } from "./emoji/favorite-index"
import { EmojiLabeler } from "./emoji/label"

const RETRY_DELAY_MS = 1000
/** 机器人连接被别的实例占用时，多久重试一次接管。 */
const CLAIM_RETRY_MS = 30_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default Plugin.define({
  id: "opencode-qq-bot",
  async setup(ctx) {
    // 配置还没解析出来，先用一个只写控制台的日志器兜底，解析完再换成正式日志器。
    const bootstrap = createLogger("[qq-bot]", { file: false })
    let config: QQBotConfig
    const warnings: string[] = []
    try {
      config = resolveConfig(ctx.options, process.env, (message) => warnings.push(message))
    } catch (error) {
      for (const warning of warnings) bootstrap.warn(warning)
      bootstrap.error(error instanceof Error ? error.message : String(error))
      return
    }

    const logger = createLogger("[qq-bot]", {
      level: config.log.level,
      dir: config.log.dir,
      maxSize: config.log.maxSize,
      maxFiles: config.log.maxFiles,
      knownSecrets: [...collectEnvSecrets(process.env), config.napcat.token ?? ""].filter(
        (secret) => secret.length > 0,
      ),
    })
    for (const warning of warnings) logger.warn(warning)

    if (config.groups.length === 0 && config.users.length === 0) {
      logger.warn(
        "未配置目标群号或私聊 QQ 号，插件不会响应任何消息（请设置 groups/users 或 QQ_TARGET_GROUPS/QQ_TARGET_USERS）",
      )
    }

    // 机器人固定服务的工作目录：配置优先，否则固定使用 XDG 数据目录下的工作区。
    const home = await resolveHome(config.home, logger)

    // 同一台机器只允许一个插件实例：OpenCode 可能为不同项目目录加载插件，
    // 新实例接管旧实例并让旧实例整体卸载，避免多条 NapCat 连接与重复投递。
    const { previous, occupied, lease } = claimInstance(
      home.directory,
      `${ctx.location.directory}\n${config.napcat.url}`,
    )
    if (occupied) {
      logger.warn("本机机器人已绑定到其它工作目录，本实例不会运行", `工作目录：${occupied}`)
      return
    }
    if (previous?.dispose) {
      logger.info("接管已有的插件实例并卸载它", previous.label)
      try {
        await previous.dispose()
      } catch (error) {
        logger.error("卸载旧插件实例失败", error)
      }
    }

    // 机器级锁：抢不到就保持安静，等持有者退出后再接管。
    let botLock: BotLock | undefined
    let disposed = false

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
    const mediaDir = defaultMediaDir()
    const media = await createMediaStore(logger, { root: mediaDir })
    // 出站媒体把关：只允许工作目录、媒体目录和配置里放开的目录，远端地址只允许公网。
    const outbound = new OutboundMedia({
      workspace: home.directory,
      allowedDirs: [home.directory, mediaDir, ...config.media.allowedDirs],
    })
    const nameCache = new Map<string, { name: string; expires: number }>()
    const history = createHistoryProvider({ api: client.api, logger, media, names: nameCache })
    // 出站限流：模型驱动的发送与插件自己发的消息共用一个限流器。
    const limiter = new SendRateLimiter(config.rateLimit)
    // 出站敏感信息拦截：环境变量里的凭证与 NapCat 令牌都当作已知凭证。
    const sensitive = new SensitiveChecker({
      enabled: config.sensitive.enabled,
      knownSecrets: [...collectEnvSecrets(process.env), config.napcat.token ?? ""].filter(
        (secret) => secret.length > 0,
      ),
    })
    const manager = new SessionManager(ctx, config, logger, home, history)
    await manager.load()
    // 保活心跳：OpenCode 长时间没有会话活动时会卸载 location，插件随之被卸载。
    const keepAlive = new KeepAlive(ctx, config, logger)
    keepAlive.start()
    const mediaCleanup = setInterval(
      () => {
        void media.cleanup()
      },
      60 * 60 * 1000,
    )
    const mediaHandle = mediaCleanup as { unref?: () => void }
    mediaHandle.unref?.()
    // 收藏表情：标签只存在 NapCat 侧，插件不保存副本；编号由插件自己维护。
    const favorites = new FavoriteStore((method, params) => client.callApi(method, params), logger)
    const favoriteIndex = new FavoriteIndex(ctx.storage, logger)
    const labeler = new EmojiLabeler({ ctx, config, logger, media, favorites })
    const toolRegistration = await registerTools({
      ctx,
      config,
      logger,
      manager,
      client,
      favorites,
      favoriteIndex,
      limiter,
      sensitive,
      outbound,
    })
    const emojiCommandRegistration = await registerEmojiCommand({
      ctx,
      config,
      logger,
      manager,
      client,
      favorites,
      favoriteIndex,
      labeler,
      limiter,
    })
    // QQ 会话里禁止模型调用内置 question 工具，改用 qq_send_message 询问用户。
    const askGuardRegistration = await registerAskGuard({ ctx, logger, manager })
    // 禁止连续调用发送工具，避免同一条消息被重复发送。
    const sendGuardRegistration = await registerSendGuard({ ctx, logger, manager })

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
          text: formatModelMessage({
            sender: userName,
            userId: String(event.user_id),
            text: rendered.text,
            time: event.time,
          }),
          files: rendered.files,
          atMe,
          source: { id: String(event.message_id), time: event.time },
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
      // 没有占用机器人连接时不消费消息，避免和别的实例重复投递。
      if (!botLock) return
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

    let subscribed = false
    const startConsuming = async () => {
      // 先注册监听再连接：NapCat 连接期间推送的消息也会被收到。
      if (!subscribed) {
        subscribed = true
        client.onGroupMessage(scheduleMessage)
        client.onPrivateMessage(scheduleMessage)
      }
      await client.connectSafe()
    }

    /**
     * 抢占机器级锁。
     *
     * 拿到锁才能消费消息流；锁被占用说明别的实例已经在消费，这里保持安静。
     */
    const claimBot = async (): Promise<boolean> => {
      if (botLock) return true
      if (disposed) return false
      let lock: BotLock | undefined
      try {
        lock = await acquireBotLock({
          onCompromised: (error) => {
            // 心跳失效意味着锁已不再独占，立刻停止投递，等重新抢到锁再消费。
            logger.error("机器人连接锁失效，停止接收 QQ 消息", error)
            botLock = undefined
          },
        })
      } catch (error) {
        // 锁目录异常（tmpdir 不可写、权限不足）不能拖垮插件，退化成不消费消息，稍后重试。
        logger.error("获取机器人连接锁失败，稍后重试", error)
        return false
      }
      if (!lock) return false
      if (disposed) {
        // 卸载与抢锁并发：立刻交回锁，不要在卸载之后重新连接 NapCat。
        await lock.release().catch((error: unknown) => logger.error("释放机器人连接锁失败", error))
        return false
      }
      botLock = lock
      logger.info("已占用机器级锁", botLockPath())
      await startConsuming()
      return true
    }

    const claimed = await claimBot().catch((error: unknown) => {
      logger.error("抢占机器人连接失败，稍后重试", error)
      return false
    })
    if (!claimed) {
      logger.warn(
        "同一台机器上已有另一个实例在运行，本实例不会接收 QQ 消息",
        `锁目录：${botLockPath()}`,
      )
    }

    // 持有者退出后接管机器人，避免消息流一直无人消费。
    const claimTimer = setInterval(() => {
      if (botLock) return
      void claimBot().catch((error: unknown) => logger.error("接管机器人连接失败", error))
    }, CLAIM_RETRY_MS)
    const claimHandle = claimTimer as { unref?: () => void }
    claimHandle.unref?.()

    // 主动说话心跳。
    let timer: ReturnType<typeof setInterval> | undefined
    if (config.proactive.enabled) {
      const tickMutex = new Mutex()
      const tick = async () => {
        if (tickMutex.isLocked()) return
        await tickMutex.runExclusive(async () => {
          for (const target of configuredTargets(config)) {
            // 没有机器人连接就发不出去，不主动发起话题。
            if (!botLock) continue
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

    logger.info("插件已加载", {
      groups: config.groups,
      users: config.users,
      napcat: config.napcat.url,
      agent: config.agent ?? "(默认)",
    })

    const dispose = async () => {
      if (disposed) return
      disposed = true
      if (timer) clearInterval(timer)
      clearInterval(claimTimer)
      clearInterval(mediaCleanup)
      await keepAlive.dispose()
      idleAbort.abort()
      manager.dispose()
      await manager.flush()
      soul.dispose()
      await toolRegistration.dispose()
      await emojiCommandRegistration.dispose()
      await labeler.dispose()
      await askGuardRegistration.dispose()
      await sendGuardRegistration.dispose()
      await contextRegistration.dispose()
      await idleRegistration.dispose()
      client.dispose()
      // 先断开 NapCat 再释放机器级锁，避免新实例接管时出现两条连接。
      try {
        await botLock?.release()
      } catch (error) {
        // 释放失败也要继续释放实例租约，否则旧实例的租约会一直占着槽位。
        logger.error("释放机器人连接锁失败", error)
      }
      botLock = undefined
      lease.release()
      logger.info(
        "插件已卸载",
        "若是被 OpenCode 卸载（长时间没有会话活动），可在 opencode.json 里设置 experimental.location_idle_timeout: false",
      )
      // 关闭日志器，等文件传输把最后的日志写完，避免丢日志。
      await flushLogger()
      await closeLogger()
    }
    lease.setDispose(dispose)
    return dispose
  },
})
