import { join, resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import type { GroupMessageEvent, MessageEvent, NoticeEvent } from "@naplink/naplink"
import { Mutex } from "async-mutex"
import { delay, unrefTimer } from "./async"
import { acquireBotLock, type BotLock, botLockPath } from "./bot-lock"
import { type ChatTarget, targetKey, targetLabel } from "./chat"
import { allowedTargets, isTargetAllowed } from "./access"
import type { QQBotConfig } from "./config"
import { ConfigController } from "./config/live"
import { ConfigStore, CONFIG_FILE_NAME } from "./config/store"
import { DiaryCollector, isSelfSpeaker } from "./diary/collector"
import { createDiaryRunner, diaryCommand } from "./diary/command"
import { DiaryScheduler } from "./diary/scheduler"
import { isDiaryScopeChat } from "./diary/scope"
import { DiaryStore } from "./diary/store"
import { DiarySummarizer } from "./diary/summary"
import { resolveHome } from "./home"
import { claimInstance, takeHandover } from "./instance"
import { KeepAlive } from "./keepalive"
import { createLogger, closeLogger, defaultLogDir, flushLogger, setLogLevel } from "./logger"
import { defaultMediaDir, OutboundMedia } from "./media-path"
import { formatModelMessage } from "./model-view"
import { QQClient } from "./naplink/client"
import { createHistoryProvider } from "./naplink/history"
import { createMediaStore } from "./naplink/media"
import {
  describeMentions,
  extractDiaryText,
  renderMessage,
  resolveUserName,
  shouldProcess,
} from "./naplink/render"
import { PanelRuntime } from "./panel/runtime"
import { createModelProvider } from "./panel/models"
import { PanelServer } from "./panel/server"
import { SendRateLimiter } from "./rate-limit"
import { startClaimTimer } from "./runtime/claim"
import { RuntimeStart } from "./runtime/start"
import { packageRoot, seedFile } from "./seed"
import { collectEnvSecrets, redactUrl, secretsFromUrl, SensitiveChecker } from "./sensitive"
import { SessionManager } from "./session/manager"
import { currentTimeText, PROACTIVE_HINT } from "./session/prompt"
import { proactiveProbability } from "./session/proactive"
import { packageDirectory, seedSouls, SoulLibrary } from "./session/soul"
import { COMMANDS, handleCommand, isCommandChat } from "./commands"
import {
  chatMuted,
  ChatOverrides,
  defaultChatOverridesPath,
  proactiveAllowed,
  wakeDecision,
  type WakeReason,
} from "./overrides"
import { Tracer } from "./trace"
import { Cleanup, CleanupOrder } from "./cleanup"
import { registerAskGuard } from "./tools/ask-guard"
import { defaultToolProfilesPath, roleOf, ToolPolicy } from "./tools/policy"
import { registerToolPolicy } from "./tools/policy-guard"
import { registerSendGuard } from "./tools/send-guard"
import {
  createPlainSender,
  QQ_REQUEST_REPLY_TOOL,
  registerTools,
  sendPlainMessage,
  TOOL_NAMESPACE,
} from "./tools/qq"
import { createEmojiRunner, emojiCommand } from "./emoji/command"
import { describeNotice, noticeMatches, noticeTarget } from "./events/notice"
import { NoticeStore } from "./events/store"
import { registerTuiCommands } from "./tui-commands"
import { pluginVersion } from "./version"
import { FavoriteStore } from "./emoji/favorites"
import { FavoriteIndex } from "./emoji/favorite-index"
import { CollectionStore, RecentImages } from "./emoji/collection"
import { EmojiLabeler } from "./emoji/label"

const RETRY_DELAY_MS = 1000
/** 机器人连接被别的实例占用时，多久重试一次接管。 */
const CLAIM_RETRY_MS = 30_000

/**
 * 从插件选项里取 agent。
 *
 * `opencode.json` 里只有 agent 一项会被读：agent 是 OpenCode 侧的路由语义，
 * 其余插件选项一律忽略，不生效也不告警。
 */
function agentFromOptions(options: unknown): string | undefined {
  if (!options || typeof options !== "object" || Array.isArray(options)) return undefined
  const agent = (options as Record<string, unknown>).agent
  if (typeof agent !== "string") return undefined
  const trimmed = agent.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * 已知凭证明文：日志逐行打码与出站拦截都靠它。
 *
 * 除了环境变量与 NapCat 令牌，地址查询串里挂着的 token 也要算进来，
 * 否则它会原样落进日志文件。面板令牌同样算进来：它能进日志文件就等于面板失守。
 */
export function knownSecrets(config: QQBotConfig): string[] {
  return [
    ...collectEnvSecrets(process.env),
    config.napcat.token ?? "",
    // 面板令牌能进日志文件就等于面板失守，日志里一律掩码。
    config.panel.token ?? "",
    ...secretsFromUrl(config.napcat.url),
  ].filter((secret) => secret.length > 0)
}

const isGroupEvent = (event: MessageEvent): event is GroupMessageEvent =>
  event.message_type === "group"

/** 只取消息里的文本段，用于识别管理命令。 */
function messageText(event: MessageEvent): string {
  return (event.message ?? [])
    .filter((segment) => segment.type === "text")
    .map((segment) => String((segment.data as { text?: unknown }).text ?? ""))
    .join(" ")
}

/** 必回原因对应给模型的一句话。 */
function wakeHint(reason: WakeReason | undefined): string {
  switch (reason) {
    case "private":
      return "这是一条私聊消息，必须回复。"
    case "all":
      return "这个群要求每条消息都回复，必须回复。"
    case "mention":
      return "你被 @ 了，必须回复。"
    case "prefix":
      return "这条消息命中了唤醒前缀，必须回复。"
    case "at_all":
      return "这条消息 @ 了全体成员，必须回复。"
    case "reply":
      return "这条消息回复了你，必须回复。"
    default:
      return "这条消息没有要求你回复，可以选择不回复。"
  }
}

function eventTarget(event: MessageEvent): ChatTarget {
  return isGroupEvent(event)
    ? { kind: "group", id: event.group_id }
    : { kind: "private", id: event.user_id }
}

export default Plugin.define({
  id: "opencode-qq-bot",
  async setup(ctx) {
    // 配置还没解析出来，先用一个只写控制台的日志器兜底，解析完再换成正式日志器。
    const bootstrap = createLogger("[qq-bot]", { file: false })
    const version = pluginVersion()
    const warnings: string[] = []
    // 配置告警的出口：正式日志器就绪前先攒着，就绪之后直接写日志。
    const sink: { warn: (message: string) => void } = {
      warn: (message) => {
        warnings.push(message)
      },
    }
    // 工作目录固定：配置文件就在工作目录里，位置固定才不会自举。
    const home = await resolveHome(bootstrap)
    const store = new ConfigStore(join(home.directory, CONFIG_FILE_NAME))
    const agent = agentFromOptions(ctx.options)
    const controller = new ConfigController({
      store,
      ...(agent ? { agent } : {}),
      warn: (message) => sink.warn(message),
    })

    let config: QQBotConfig
    try {
      config = await controller.load()
    } catch (error) {
      bootstrap.info(`opencode-qq-bot v${version}`)
      bootstrap.error(error instanceof Error ? error.message : String(error))
      await closeLogger(bootstrap)
      return
    }

    const logger = createLogger("[qq-bot]", {
      level: config.log.level,
      dir: config.log.dir,
      maxSize: config.log.maxSize,
      maxFiles: config.log.maxFiles,
      knownSecrets: knownSecrets(config),
    })
    logger.info(`opencode-qq-bot v${version}`)
    sink.warn = (message) => logger.warn(message)
    for (const warning of warnings) logger.warn(warning)
    // 正式日志器已经接管，兜底日志器只写控制台，用完就关掉。
    await closeLogger(bootstrap)

    if (
      config.access.allow.groups.length === 0 &&
      config.access.allow.users.length === 0 &&
      !config.access.allowAllWhenEmpty
    ) {
      logger.warn("未配置放行目标，插件不会响应任何消息（请在 config.json 里配置 access.allow）")
    }

    // 状态面板：默认开启，自带 HTTP 服务，只监听本机。
    const panelRuntime = new PanelRuntime({ config, home, logger })
    panelRuntime.version = version
    panelRuntime.agent = config.agent
    const panel = new PanelServer({
      controller,
      runtime: panelRuntime,
      models: createModelProvider(ctx.model),
      logger,
    })

    // 配置文件被外部改动时热更新：日志级别这类字段改完立即生效。
    const unsubscribeLevel = controller.onChange((next) => {
      setLogLevel(logger, next.log.level)
    })
    await controller.startWatching().catch((error: unknown) => {
      logger.warn("监听配置文件失败，配置文件改动不会自动生效", error)
    })

    // 同一台机器只允许一个插件实例：OpenCode 可能为不同项目目录加载插件，
    // 新实例接管旧实例并让旧实例整体卸载，避免多条 NapCat 连接与重复投递。
    const { previous, occupied, lease } = claimInstance(
      home.directory,
      `${ctx.location.directory}\n${redactUrl(config.napcat.url)}`,
    )
    if (occupied) {
      logger.warn("本机机器人已绑定到其它工作目录，本实例不会运行", `工作目录：${occupied}`)
      // 这个实例不会运行：把已经起来的监听停掉，别占着端口和文件监听。
      controller.stop()
      unsubscribeLevel()
      await closeLogger(logger)
      return
    }

    // 机器级锁：抢不到就保持安静，等持有者退出后再接管。
    let botLock: BotLock | undefined
    // 卸载标记：初始化途中被接管时立刻置位，让后面的初始化步骤自己停下。
    let disposed = false
    // 主动说话的定时器：初始化没走到那一步时也是 undefined。
    let proactiveTimer: ReturnType<typeof setInterval> | undefined

    // 卸载步骤随资源一起登记：初始化还没结束时新实例就会来要清理函数，
    // 那时 dispose 必须已经可用，否则两份实例并存，谁的工具生效全看谁后注册。
    const cleanup = new Cleanup()
    let disposeStarted = false
    const dispose = async () => {
      if (disposeStarted) return
      disposeStarted = true
      // 先让初始化停下：它会检查 disposed，不再注册工具、不再抢锁。
      disposed = true
      await cleanup.run(logger)
    }
    lease.setDispose(dispose)
    cleanup.add("停止状态面板", () => panel.stop(), CleanupOrder.panel)
    cleanup.add("停止配置监听", () => controller.stop(), CleanupOrder.panel)
    cleanup.add(
      "取消配置订阅",
      () => {
        unsubscribeLevel()
      },
      CleanupOrder.panel,
    )
    cleanup.add(
      "记录卸载日志",
      () =>
        logger.info(
          "插件已卸载",
          "若是被 OpenCode 卸载（长时间没有会话活动），可在 opencode.json 里设置 experimental.location_idle_timeout: false",
        ),
      CleanupOrder.logs,
    )
    cleanup.add("冲刷日志", () => flushLogger(logger), CleanupOrder.logs)
    cleanup.add("关闭日志器", () => closeLogger(logger), CleanupOrder.logs)
    cleanup.add(
      "释放机器人连接锁",
      async () => {
        try {
          await botLock?.release()
        } finally {
          // 释放失败也要清掉句柄，否则下一次接管会被自己挡住。
          botLock = undefined
        }
      },
      CleanupOrder.lock,
    )
    cleanup.add("释放实例租约", () => lease.release(), CleanupOrder.lease)

    if (previous?.dispose) {
      logger.info("接管已有的插件实例并卸载它", previous.label)
      // 旧实例的清理可能卡在在途投递上，最多等一会儿：
      // 它释放机器级锁之后我们才能接管，等不到就按没抢到锁处理，稍后重试。
      await Promise.race([
        previous.dispose().catch((error: unknown) => {
          logger.error("卸载旧插件实例失败", error)
        }),
        delay(CLAIM_RETRY_MS),
      ])
    }

    // 状态面板：确认自己是有效实例、并且旧实例已经交还端口之后才监听。
    // 面板没起来不影响机器人主体运行，这里只记日志。
    if (!disposed) {
      await panel.start().catch((error: unknown) => {
        logger.error("启动状态面板失败", error)
      })
    }

    // 保活心跳先起来：等锁的实例也得活着，持有者退出后才能接管。
    // OpenCode 按 location 统计会话活动，空闲太久会把插件卸载掉。
    const keepAlive = new KeepAlive(ctx, config, logger)
    cleanup.add("停止保活心跳", () => keepAlive.dispose(), CleanupOrder.keepAlive)
    keepAlive.start()

    /**
     * 抢占机器级锁。
     *
     * 锁必须在最开始就抢：没拿到锁的实例不注册工具、不挂钩子、也不连 NapCat。
     * 工具表在进程内共享，后注册的那份会覆盖持有者的实现，
     * 模型就会调到没有连接的那一份。
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
      return true
    }

    /** 释放机器级锁；初始化失败和卸载都走这一条路。 */
    const releaseBotLock = async (): Promise<void> => {
      const lock = botLock
      botLock = undefined
      if (!lock) return
      try {
        await lock.release()
      } catch (error) {
        logger.error("释放机器人连接锁失败", error)
      }
    }

    // 运行时只在拿到锁之后才搭：工具、钩子、NapCat 连接都归持有者。
    // 启动状态由 RuntimeStart 统一保管：全部步骤成功才算启动完成。
    const runtimeStart = new RuntimeStart({
      // 卸载已经开始就不再搭运行时：这时注册会覆盖接管方的工具。
      canStart: () => !disposed,
      setup: async () => {
        // 角色设定：先把随包分发的初始文件补进工作目录，之后一直读工作目录里的副本，
        // 升级插件不会覆盖掉用户改过的设定。默认档之外还能按聊天覆盖，改完下一轮即生效。
        const soulOptions = {
          soulPath: config.soulPath,
          soulName: config.soulName,
          home: home.directory,
          moduleDir: packageDirectory(),
        }
        await seedSouls(soulOptions, logger)
        const souls = new SoulLibrary(soulOptions, logger)
        cleanup.add("停止角色设定热重载", () => souls.dispose(), CleanupOrder.souls)
        await souls.loadDefault()

        const client = new QQClient(config.napcat, logger)
        cleanup.add("断开 NapCat", () => client.dispose(), CleanupOrder.napcat)
        panelRuntime.client = client
        const mediaDir = defaultMediaDir()
        const media = await createMediaStore(logger, { root: mediaDir })
        // 出站媒体把关：只允许工作目录、媒体目录和配置里放开的目录，远端地址只允许公网。
        const outbound = new OutboundMedia({
          workspace: home.directory,
          allowedDirs: [home.directory, mediaDir, ...config.media.allowedDirs],
        })
        // 普通群成员与主动说话只允许媒体目录：模型能调 send_image 不等于能读整台机器。
        const outboundMember = new OutboundMedia({
          workspace: home.directory,
          allowedDirs: [mediaDir],
        })
        const nameCache = new Map<string, { name: string; expires: number }>()
        /** 渲染上下文：上游 API、媒体存储与昵称缓存都在这里一次性绑定。 */
        const renderContext = (target: ChatTarget, selfId?: string) => ({
          api: client.api,
          target,
          logger,
          media,
          names: nameCache,
          ...(selfId ? { selfId } : {}),
        })
        const history = createHistoryProvider({
          api: client.api,
          logger,
          media,
          names: nameCache,
          roleOf: (userId) => roleOf(config, userId),
        })
        // 出站限流：模型驱动的发送与插件自己发的消息共用一个限流器。
        const limiter = new SendRateLimiter(config.rateLimit)
        panelRuntime.limiter = limiter
        // 出站敏感信息拦截：环境变量里的凭证与 NapCat 令牌都当作已知凭证。
        const sensitive = new SensitiveChecker({
          enabled: config.sensitive.enabled,
          knownSecrets: knownSecrets(config),
        })
        // 敏感拦截开关是热字段：改完立即生效。
        const unsubscribeSensitive = controller.onChange((next) => {
          sensitive.setEnabled(next.sensitive.enabled)
        })
        cleanup.add("取消敏感检查订阅", () => unsubscribeSensitive(), CleanupOrder.panel)
        // 通知缓存：通知不自己起一轮，只在下一次该聊天的上下文里附带出现。
        const noticeStore = new NoticeStore()
        // 工具配置：按聊天与角色决定模型能看到、能调用哪些工具。
        // 走默认位置时把随包的示例复制过去，占位目标得自己改成真实的群 / 私聊。
        const profilesPath = config.toolProfilesPath
          ? resolve(home.directory, config.toolProfilesPath)
          : defaultToolProfilesPath(home.directory)
        if (!config.toolProfilesPath) {
          await seedFile(join(packageRoot, "tool-profiles.example.json"), profilesPath, logger)
        }
        const policy = new ToolPolicy(profilesPath, logger)
        panelRuntime.policy = policy
        // 会话行为覆盖：按聊天决定怎么唤醒、要不要主动说话。
        const overridesPath = config.chatOverridesPath
          ? resolve(home.directory, config.chatOverridesPath)
          : defaultChatOverridesPath(home.directory)
        if (!config.chatOverridesPath) {
          await seedFile(join(packageRoot, "chat-overrides.example.json"), overridesPath, logger)
        }
        const overrides = new ChatOverrides(overridesPath, logger)
        panelRuntime.overrides = overrides
        // 调用链追踪：一条入站消息拿一个 trace_id，事后能把这轮串起来。
        // 追踪文件与日志放在一起，容量与保留天数都有上限。
        const tracer = config.trace.enabled
          ? new Tracer({
              dir: config.trace.dir.trim() || config.log.dir.trim() || defaultLogDir(),
              maxSizeMb: config.trace.maxSizeMb,
              retentionDays: config.trace.retentionDays,
              logger,
            })
          : undefined
        await tracer?.prune()
        panelRuntime.tracer = tracer
        const manager = new SessionManager(
          ctx,
          config,
          logger,
          home,
          history,
          async (target, text) => {
            // 失败兜底只发插件自己的固定文案，走上游异常原文永远不进聊天。
            await sendPlainMessage(client, target, text, { limiter })
          },
          overrides,
          tracer,
        )
        cleanup.add("停止会话管理", () => manager.dispose(), CleanupOrder.manager)
        panelRuntime.manager = manager
        cleanup.add("落盘会话状态", () => manager.flush(), CleanupOrder.persist)
        // 交接在途状态最先做：接管方要拿到上一轮还在跑的状态。
        cleanup.add(
          "交接在途状态",
          async () => {
            // 被新实例接管时才等在途投递落地：那一次交接才有东西可交。
            lease.handover(lease.superseded() ? await manager.exportHandover() : [])
          },
          CleanupOrder.handover,
        )
        await manager.load()
        // 接管上一实例留下的在途状态：那一轮还在上游跑，丢掉的话这轮的回复就没了。
        // 只有真的接管了旧实例才有东西可接。
        if (previous) {
          const handover = takeHandover()
          if (handover.length > 0) {
            const adopted = await manager.adoptHandover(handover)
            logger.info(`已接管上一实例的 ${adopted} 个聊天状态`)
          }
        }
        // 进程重启时上游可能还在跑上一轮；恢复它的状态，否则模型调用 QQ 工具会被拒绝。
        await manager.restoreInflight()
        const mediaCleanup = setInterval(
          () => {
            void media.cleanup()
          },
          60 * 60 * 1000,
        )
        unrefTimer(mediaCleanup)
        cleanup.add("停止媒体清理定时器", () => clearInterval(mediaCleanup), CleanupOrder.events)
        // 收藏表情：标签只存在 NapCat 侧，插件不保存副本；编号由插件自己维护。
        const favorites = new FavoriteStore(
          (method, params) => client.callApi(method, params),
          logger,
        )
        const favoriteIndex = new FavoriteIndex(ctx.storage, logger)
        // 本机收集的表情：QQ 收藏表情写不进 NapCat，收集的动图自己存在媒体目录里。
        const collection = new CollectionStore(ctx.storage, mediaDir, logger)
        // 各聊天最近收到的图片：收藏表情时从中挑素材。
        const recentImages = new RecentImages()
        const labeler = new EmojiLabeler({ ctx, config, home, logger, media, favorites })
        cleanup.add("注销表情标注", () => labeler.dispose(), CleanupOrder.labeler)
        // 日记：素材累积在 raw/ 下，成品是按天一个的 Markdown 文件。
        // 日记目录默认落在机器人工作目录里，因此天然在出站媒体白名单内。
        const diaryRoot = config.diary.path.trim()
          ? resolve(home.directory, config.diary.path)
          : join(home.directory, "diary")
        const diaryStore = new DiaryStore({ root: diaryRoot, logger })
        const diaryCollector = new DiaryCollector({
          root: diaryRoot,
          logger,
          maxLineChars: config.diary.maxLineChars,
          maxLinesPerDay: config.diary.maxLinesPerDay,
        })
        const diarySummarizer = new DiarySummarizer({
          ctx,
          config,
          home,
          logger,
          collector: diaryCollector,
          store: diaryStore,
          timeoutMs: config.diary.timeoutMs,
        })
        cleanup.add("注销日记总结", () => diarySummarizer.dispose(), CleanupOrder.labeler)
        const diaryScheduler = new DiaryScheduler({
          config,
          logger,
          client,
          limiter,
          outbound,
          sensitive,
          store: diaryStore,
          collector: diaryCollector,
          summarizer: diarySummarizer,
        })
        cleanup.add("停止日记调度", () => diaryScheduler.dispose(), CleanupOrder.events)
        panelRuntime.diary = diaryScheduler
        // QQ 工具只有持有机器级锁的实例才注册：工具表在进程内共享，
        // 没锁的实例注册了会覆盖持有者的实现，模型就会调到没有连接的那一份。
        let toolRegistration: { dispose(): Promise<void> } | undefined
        const registerRuntime = async (): Promise<void> => {
          if (toolRegistration) return
          // 卸载已经开始就不再注册：这时注册会覆盖接管方的工具。
          if (disposed) return
          const registration = await registerTools({
            ctx,
            config,
            logger,
            manager,
            client,
            favorites,
            favoriteIndex,
            collection,
            recentImages,
            limiter,
            sensitive,
            outbound,
            outboundMember,
            diary: diaryStore,
            tracer,
            // 没有机器级锁的实例不能发送：那是别的实例的机器人。
            canSend: () => botLock !== undefined,
          })
          toolRegistration = registration
          cleanup.add("注销工具", () => registration.dispose(), CleanupOrder.tools)
        }
        // 命令表：管理命令 + 表情标注 + 日记，QQ 私聊与 TUI 共用同一套实现。
        const commands = [
          ...COMMANDS,
          emojiCommand(
            createEmojiRunner({
              config,
              logger,
              client,
              favorites,
              favoriteIndex,
              labeler,
              limiter,
            }),
          ),
          diaryCommand(
            createDiaryRunner({
              config,
              logger,
              client,
              limiter,
              outbound,
              sensitive,
              store: diaryStore,
              collector: diaryCollector,
              summarizer: diarySummarizer,
            }),
          ),
        ]
        // 命令结果统一走限流；发送失败只记日志，不影响命令本身。
        const replyTo = createPlainSender(client, {
          delayMs: config.sendDelayMs,
          limiter,
          logger,
          failure: (target) => `${targetLabel(target)} 发送命令结果失败`,
        })
        const tuiCommandRegistration = await registerTuiCommands({
          ctx,
          config,
          logger,
          manager,
          policy,
          overrides,
          client,
          limiter,
          commands,
        })
        cleanup.add("注销 TUI 命令", () => tuiCommandRegistration.dispose(), CleanupOrder.tui)
        // QQ 会话里禁止模型调用内置 question 工具，改用 qq_send_message 询问用户。
        const askGuardRegistration = await registerAskGuard({ ctx, logger, manager })
        // 禁止连续调用发送工具，避免同一条消息被重复发送。
        const sendGuardRegistration = await registerSendGuard({ ctx, logger, manager })
        // 按聊天与角色收窄工具：上下文里先删，执行前再挡一次。
        const toolPolicyRegistration = await registerToolPolicy({ ctx, logger, manager, policy })
        cleanup.add(
          "注销工具守卫",
          async () => {
            await askGuardRegistration.dispose()
            await sendGuardRegistration.dispose()
            await toolPolicyRegistration.dispose()
          },
          CleanupOrder.guards,
        )

        // 系统提示：角色设定、当前时间、本轮是否必须回复。
        const contextRegistration = await ctx.session.hook("context", async (event) => {
          const target = manager.targetForSession(event.sessionID)
          if (target === undefined) {
            // 表情标签会话不绑定 QQ 目标，拿不到按聊天的工具限制；
            // 它的输入是一张图片，工具一律摘掉，只让模型输出标签。
            if (await labeler.isLabelSession(event.sessionID)) {
              for (const name of Object.keys(event.tools)) delete event.tools[name]
              return
            }
            // 日记总结会话的输入是群友可控的聊天记录，同样不带任何工具。
            if (await diarySummarizer.isSummarySession(event.sessionID)) {
              for (const name of Object.keys(event.tools)) delete event.tools[name]
            }
            return
          }
          // 角色设定可以按聊天覆盖：先看覆盖里写的路径，没有就用默认档。
          const override = await overrides.for(target)
          const soul = await souls.at(override.soul)
          event.system.push({ type: "text", text: soul.prompt })
          event.system.push({ type: "text", text: `当前时间：${currentTimeText()}` })
          const active = manager.activeTurn(event.sessionID)
          const turn = active?.turn
          const role = active?.role ?? manager.currentRole(event.sessionID)
          logger.debug(`上下文钩子：会话 ${event.sessionID}`, {
            target: targetLabel(target),
            role,
            proactive: turn?.proactive === true,
            atMe: turn?.atMe,
            suppress: turn?.suppress,
            tools: Object.keys(event.tools).length,
            ...(turn?.traceId ? { trace_id: turn.traceId } : {}),
          })
          const destination = target.kind === "group" ? "群里" : "私聊里"
          // 模型开始处理这一轮：记一个追踪节点。
          if (turn?.traceId) {
            await tracer?.record(
              "handler_start",
              turn.traceId,
              { session_id: event.sessionID },
              targetKey(target),
            )
          }
          event.system.push({
            type: "text",
            text: turn?.proactive
              ? `这是一次主动发起话题，必须调用 qq_send_message 把话题发到${destination}。${target.kind === "group" && config.reply.requirePermission ? "群里要先调用 qq_request_reply 说明为什么要回复，说明之后才能发送。" : ""}`
              : turn?.atMe
                ? wakeHint(turn.wake)
                : turn?.suppress
                  ? "这条消息不是在跟你说话，不要回复。"
                  : wakeHint(undefined),
          })
          // 待注入的通知：作为附带信息出现，不要求模型回复。
          const notices = noticeStore.take(target)
          if (notices.length > 0) {
            event.system.push({
              type: "text",
              text: `聊天里发生过的通知（不需要回复）：\n${notices.map((item) => `- ${item}`).join("\n")}`,
            })
          }
          // 群里默认不主动发言：模型得先想清楚该不该回复，说明理由才发。
          if (target.kind === "group" && config.reply.requirePermission) {
            event.system.push({
              type: "text",
              text: `按约定，你在群里不会主动发消息。要回复，先判断该不该回复，再调用 ${QQ_REQUEST_REPLY_TOOL} 说明为什么要回复；说明之后才能调用 qq_send_message，这个约定只在本轮有效。`,
            })
          }
          // 本轮发送者的角色决定工具档：owner / admin 全开，其他按聊天配置。
          // 角色按会话保留，没有在途轮次（重启、TUI 驱动）时也照样收窄。
          {
            const allowed = await policy.allow(role, targetKey(target), Object.keys(event.tools))
            const removed: string[] = []
            for (const name of Object.keys(event.tools)) {
              // 申请回复权限的工具必须一直留着：不然模型永远拿不到发送权限。
              if (name === QQ_REQUEST_REPLY_TOOL) continue
              if (!allowed.has(name)) {
                removed.push(name)
                delete event.tools[name]
              }
            }
            const profile = await policy.profileOf(role, targetKey(target))
            // 模型这一轮实际能用的 QQ 工具：模型只认这些名字，缺一个就发不出消息。
            const qqTools = Object.keys(event.tools).filter((name) =>
              name.startsWith(`${TOOL_NAMESPACE}_`),
            )
            logger.debug(`上下文钩子：按角色收窄工具`, {
              target: targetLabel(target),
              role,
              profile,
              removed,
              qqTools,
            })
            if (!qqTools.includes("qq_send_message")) {
              logger.warn(`${targetLabel(target)} 模型这一轮看不到 qq_send_message，发不出消息`, {
                role,
                profile,
                removed,
              })
            }
          }
        })
        cleanup.add("注销上下文钩子", () => contextRegistration.dispose(), CleanupOrder.hooks)

        // 会话空闲：冲刷缓存消息，或提醒模型补一次发送。
        const idleRegistration = await ctx.session.hook("experimental.idle", async (event) => {
          logger.debug(`experimental.idle 钩子：会话 ${event.sessionID}`, {
            background: event.background.map((task) => task.sessionID),
          })
          await manager.handleIdle(event.sessionID, event.background)
        })
        cleanup.add("注销空闲钩子", () => idleRegistration.dispose(), CleanupOrder.hooks)

        // 会话空闲后，把队列里缓存的消息合并成新的一轮。
        // `session.status` 是官方推荐的状态信号；2.2.5 实际只在执行结束时发
        // `session.execution.succeeded`，所以两者都要监听。失败或中断单独结束轮次。
        // 订阅断掉后自动重连。
        const idleAbort = new AbortController()
        cleanup.add("中断事件订阅", () => idleAbort.abort(), CleanupOrder.events)
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
                // 单条事件处理失败只记日志：连带把订阅循环拆掉会让缓存消息再也发不出去。
                try {
                  const sessionID = event.data.sessionID
                  logger.debug(`上游事件：${event.type}`, {
                    sessionID,
                    ...(event.type === "session.status" ? { status: event.data.status.type } : {}),
                  })
                  if (event.type === "session.status") {
                    if (event.data.status.type === "idle") await manager.flushBuffered(sessionID)
                  } else if (event.type === "session.execution.succeeded") {
                    await manager.flushBuffered(sessionID)
                  } else {
                    // 失败事件带上游错误信息，只进日志（logger 会脱敏），不进聊天。
                    const detail =
                      event.type === "session.execution.failed"
                        ? event.data.error.message
                        : undefined
                    await manager.handleExecutionEnd(sessionID, event.type, detail)
                  }
                } catch (error) {
                  logger.warn("处理会话事件失败", error)
                }
              }
            } catch (error) {
              if (idleAbort.signal.aborted) break
              logger.error("订阅会话事件失败，稍后重试", error)
            }
            if (!idleAbort.signal.aborted) await delay(RETRY_DELAY_MS)
          }
        })()

        const handleMessage = async (
          event: MessageEvent,
          target: ChatTarget,
          selfId: string,
          traceId?: string,
        ) => {
          try {
            if (!isTargetAllowed(config.access, target, config.ownerQQ)) return
            const override = await overrides.for(target)
            // wake=none 的群完全不理：不投递，也不回复。
            if (chatMuted(override, target)) return
            // 管理命令只在 owner / 管理员自己的私聊里生效；群聊、别人的私聊、未知命令都交给模型。
            if (isCommandChat(config, target, String(event.user_id))) {
              const handled = await handleCommand(
                messageText(event),
                {
                  config,
                  manager,
                  policy,
                  overrides,
                  target,
                  source: "qq",
                  send: replyTo,
                  toolNames: async () => (await ctx.tool.list()).map((tool) => tool.id),
                },
                commands,
              )
              if (handled) return
            }
            if (!shouldProcess(event.message, selfId)) return

            const renderCtx = renderContext(target, selfId)
            const rendered = await renderMessage(renderCtx, event)
            if (!rendered.text.trim()) return
            // 记下这张消息里的图片：收藏表情时从中挑最近收到的那张动图。
            await recentImages.record(target, rendered.files, String(event.message_id))

            const senderRole = roleOf(config, String(event.user_id))
            const userName = await resolveUserName(renderCtx, String(event.user_id))
            // 私聊消息默认都是对机器人说的；群里按会话覆盖与全局唤醒策略决定什么时候必须回复。
            const mentions = describeMentions(event.message, selfId)
            const decision = wakeDecision(
              override,
              target,
              {
                mentioned: mentions.mentioned,
                atAll: mentions.atAll,
                atOthersFirst: mentions.atOthersFirst,
                replyToSelf: rendered.replyToSelf === true,
                text: messageText(event),
              },
              config.wake,
            )

            logger.info(`${targetLabel(target)} 消息交给模型`, {
              user: String(event.user_id),
              role: senderRole,
              required: decision.required,
              ...(decision.reason ? { reason: decision.reason } : {}),
            })
            await manager.enqueue(target, {
              text: formatModelMessage({
                sender: userName,
                userId: String(event.user_id),
                text: rendered.text,
                time: event.time,
                role: senderRole,
              }),
              files: rendered.files,
              atMe: decision.required,
              ...(decision.reason ? { wake: decision.reason } : {}),
              ...(decision.suppress ? { suppress: true } : {}),
              ...(traceId ? { traceId } : {}),
              role: senderRole,
              senderId: String(event.user_id),
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
        /**
         * 采集一条入站消息的日记素材。
         *
         * 落盘是异步的，不挡消息处理：写失败只记日志，不影响聊天。
         */
        const collectDiaryLine = (
          event: MessageEvent,
          target: ChatTarget,
          selfId: string,
        ): void => {
          if (!config.diary.enabled) return
          // 日记只记 owner 自己的私聊，群聊与别人的私聊都不进素材。
          if (!isDiaryScopeChat(config, target)) return
          const content = extractDiaryText(event.message)
          if (!content) return
          const userId = String(event.user_id)
          void (async () => {
            let name = ""
            try {
              name = await resolveUserName(renderContext(target, selfId), userId)
            } catch {
              // 取不到显示名就退回 QQ 号。
            }
            await diaryCollector.append(targetKey(target), {
              id: String(event.message_id),
              time: event.time,
              userId,
              name: name || userId,
              text: content,
              self: isSelfSpeaker(userId, selfId),
              backfilled: false,
            })
          })().catch((error: unknown) => logger.error("采集日记素材失败", error))
        }

        const scheduleMessage = (event: MessageEvent) => {
          // 没有占用机器人连接时不消费消息，避免和别的实例重复投递。
          if (!botLock) return
          const target = eventTarget(event)
          if (!isTargetAllowed(config.access, target, config.ownerQQ)) return
          const selfId = String(event.self_id ?? client.selfId ?? "")

          if (!manager.rememberIncoming(target, String(event.message_id))) {
            logger.debug(`忽略重复消息 ${event.message_id}`)
            return
          }
          manager.touch(target)
          // 日记素材：放在去重之后，重复投递的消息只会被记一次。
          collectDiaryLine(event, target, selfId)
          // 机器人自己说的话也要进素材，但不再交给模型处理。
          if (isSelfSpeaker(String(event.user_id), selfId)) return
          logger.info(`${targetLabel(target)} 收到 QQ 消息`, {
            user: String(event.user_id),
            message_id: String(event.message_id),
          })

          // 一条入站消息一个追踪 id，后面各个节点都挂在它下面。
          const traceId = tracer?.startTrace()
          if (traceId) {
            void tracer?.record(
              "event_received",
              traceId,
              { message_id: String(event.message_id), user_id: String(event.user_id) },
              targetKey(target),
            )
          }

          void processingMutex(targetKey(target))
            .runExclusive(() => handleMessage(event, target, selfId, traceId))
            .catch((error: unknown) => logger.error(`处理 ${targetLabel(target)} 消息失败`, error))
        }

        /**
         * 处理通知类事件。
         *
         * 通知只记日志并缓存起来，不自己触发一轮；下一轮该聊天的上下文里会带上摘要。
         */
        const scheduleNotice = (event: NoticeEvent) => {
          if (!botLock) return
          if (!noticeMatches(event, config.events.notices)) return
          const target = noticeTarget(event)
          if (!target || !isTargetAllowed(config.access, target, config.ownerQQ)) return
          void (async () => {
            try {
              const text = await describeNotice(event, {
                nameOf: async (userId) =>
                  await resolveUserName(renderContext(target), String(userId)),
              })
              if (!text) return
              logger.info(`${targetLabel(target)} 收到通知：${text}`)
              if (config.events.inject) noticeStore.push(target, text)
            } catch (error) {
              logger.error(`处理 ${targetLabel(target)} 通知失败`, error)
            }
          })()
        }

        let subscribed = false
        const startConsuming = async () => {
          // 先注册监听再连接：NapCat 连接期间推送的消息也会被收到。
          if (!subscribed) {
            subscribed = true
            // 订阅类别是热配置：监听只注册一次，收到事件时再按当前配置决定要不要处理，
            // 这样改配置之后不用重连就能生效。
            client.onGroupMessage((event) => {
              if (!config.events.subscribe.includes("message")) return
              scheduleMessage(event)
            })
            client.onPrivateMessage((event) => {
              if (!config.events.subscribe.includes("message")) return
              scheduleMessage(event)
            })
            client.onNotice((event) => {
              if (!config.events.subscribe.includes("notice")) return
              scheduleNotice(event)
            })
          }
          await client.connectSafe()
        }

        // 主动说话心跳。
        if (config.proactive.enabled) {
          const tickMutex = new Mutex()
          const tick = async () => {
            if (tickMutex.isLocked()) return
            await tickMutex.runExclusive(async () => {
              for (const target of allowedTargets(config.access, config.ownerQQ)) {
                // 没有机器人连接就发不出去，不主动发起话题。
                if (!botLock) continue
                const override = await overrides.for(target)
                // 被覆盖成不主动说话的聊天，或不在主动说话白名单里的聊天，跳过。
                if (
                  !proactiveAllowed(override, target, {
                    allowGroups: config.proactive.allowGroups,
                    allowUsers: config.proactive.allowUsers,
                  })
                ) {
                  continue
                }
                // 聊天自己写了概率就用它，否则按全局公式随沉默时长增长。
                const probability = proactiveProbability(
                  override,
                  config.proactive,
                  manager.silenceSeconds(target),
                )
                if (probability <= 0 || Math.random() >= probability) continue
                logger.info(`${targetLabel(target)} 沉默达到阈值，主动发起话题`)
                await manager.proactive(target, PROACTIVE_HINT)
              }
            })
          }
          proactiveTimer = setInterval(() => {
            void tick().catch((error: unknown) => logger.error("主动说话心跳失败", error))
          }, config.proactive.tickSeconds * 1000)
          unrefTimer(proactiveTimer)
        }

        // 日记调度：到点生成当天的日记并推送。定时器随插件一起卸载，
        // 要保证它一直跑需要 experimental.location_idle_timeout: false。
        if (config.diary.enabled) {
          diaryScheduler.start()
        }

        // 工具先注册，模型这一轮就能看到 qq_*；再连 NapCat 开始消费。
        await registerRuntime()
        await startConsuming()
        logger.info("机器人已接管，开始接收 QQ 消息")
      },
      // 初始化失败还占着锁的话，别的实例永远接不了手；先把锁放掉再往上抛。
      onFailure: async () => {
        await releaseBotLock()
      },
    })
    const setupRuntime = (): Promise<void> => runtimeStart.run()

    // 持有者退出后接管机器人，避免消息流一直无人消费。
    // 先装定时器再抢锁：首次初始化失败时要保证后面还有重试。
    const claimTimer = startClaimTimer({
      intervalMs: CLAIM_RETRY_MS,
      shouldTry: () => botLock === undefined,
      claim: claimBot,
      onClaimed: async () => {
        // 拿到锁才搭运行时：工具、钩子与 NapCat 连接都归持有者。
        await setupRuntime()
      },
      onError: (error: unknown) => logger.error("接管机器人连接失败", error),
    })
    cleanup.add(
      "停止接管重试定时器",
      () => {
        claimTimer.stop()
        if (proactiveTimer) clearInterval(proactiveTimer)
      },
      CleanupOrder.events,
    )

    const claimed = await claimBot().catch((error: unknown) => {
      logger.error("抢占机器人连接失败，稍后重试", error)
      return false
    })
    if (claimed) {
      await setupRuntime().catch((error: unknown) => {
        // 初始化失败已经释放锁，交给上面的定时器重试，不让插件加载整个失败。
        logger.error("初始化机器人运行时失败，稍后重试", error)
      })
    } else {
      logger.warn(
        "同一台机器上已有另一个实例在运行，本实例不会接收 QQ 消息",
        `锁目录：${botLockPath()}`,
      )
    }

    logger.info("插件已加载", {
      allowGroups: config.access.allow.groups,
      allowUsers: config.access.allow.users,
      napcat: redactUrl(config.napcat.url),
      agent: config.agent ?? "(默认)",
      locked: botLock !== undefined,
    })

    return dispose
  },
})
