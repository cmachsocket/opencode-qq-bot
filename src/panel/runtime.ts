import type { QQBotConfig } from "../config"
import type { BotHome } from "../home"
import type { Logger } from "../logger"
import type { DiaryScheduler } from "../diary/scheduler"
import type { ChatOverrides } from "../overrides"
import type { QQClient } from "../naplink/client"
import type { SendRateLimiter } from "../rate-limit"
import type { SessionManager } from "../session/manager"
import type { ToolPolicy } from "../tools/policy"
import type { Tracer } from "../trace"

/**
 * 面板能看到的运行时句柄。
 *
 * 插件的运行时是逐步搭起来的（连接、会话、追踪、日记……），
 * 这里把已经就绪的句柄聚在一起，状态快照按需取用。
 */
export class PanelRuntime {
  /** 进程启动时间（毫秒）。 */
  readonly startedAt = Date.now()
  /** 插件版本。 */
  version = "unknown"
  /** 生效中的配置。 */
  config: QQBotConfig
  /** 机器人工作目录。 */
  home: BotHome
  /** 日志器。 */
  logger: Logger
  /** `opencode.json` 里的 agent，只读展示。 */
  agent?: string
  /** NapCat 连接。 */
  client?: QQClient
  /** 会话管理。 */
  manager?: SessionManager
  /** 出站限流。 */
  limiter?: SendRateLimiter
  /** 调用链追踪。 */
  tracer?: Tracer
  /** 日记调度。 */
  diary?: DiaryScheduler
  /** 工具策略。 */
  policy?: ToolPolicy
  /** 会话行为覆盖。 */
  overrides?: ChatOverrides

  constructor(options: { config: QQBotConfig; home: BotHome; logger: Logger }) {
    this.config = options.config
    this.home = options.home
    this.logger = options.logger
  }
}
