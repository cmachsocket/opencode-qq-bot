import { serve, type ServerType } from "@hono/node-server"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { ConfigController } from "../config/live"
import { packageRoot } from "../seed"
import type { Logger } from "../logger"
import { createPanelApp } from "./api"
import { PanelAuth } from "./auth"
import type { ModelProvider } from "./models"
import type { PanelRuntime } from "./runtime"

/**
 * 面板的 HTTP 服务。
 *
 * 随插件启停：插件被 OpenCode 卸载时服务一并关闭，不留残留端口。
 */

/** 面板服务的依赖。 */
export interface PanelServerOptions {
  /** 配置控制器。 */
  controller: ConfigController
  /** 运行时句柄。 */
  runtime: PanelRuntime
  /** 可用模型列表。 */
  models: ModelProvider
  /** 日志器。 */
  logger: Logger
}

/** 前端构建产物目录。 */
export function panelStaticDir(): string {
  return join(packageRoot, "web", "dist")
}

export class PanelServer {
  private server: ServerType | undefined
  private auth: PanelAuth
  /** 鉴权当前认的令牌。 */
  private token: string
  private unsubscribe: (() => void) | undefined
  /** 当前监听的地址与端口。 */
  private listening: { host: string; port: number } | undefined

  constructor(private readonly options: PanelServerOptions) {
    this.token = options.runtime.config.panel.token
    this.auth = new PanelAuth(this.token)
  }

  /** 令牌与会话管理。 */
  get sessions(): PanelAuth {
    return this.auth
  }

  /**
   * 启动服务。
   *
   * 面板默认关闭：只有 `panel.enabled` 为真时才监听。
   */
  async start(): Promise<void> {
    const config = this.options.runtime.config
    if (!config.panel.enabled) {
      this.options.logger.debug("状态面板未启用")
      return
    }
    this.unsubscribe ??= this.options.controller.onChange(() => {
      void this.reconcile()
    })
    await this.listen()
  }

  /** 停止服务。 */
  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    const server = this.server
    this.server = undefined
    this.listening = undefined
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  /** 配置变了：令牌、地址或端口变了都要跟着调整。 */
  private async reconcile(): Promise<void> {
    const config = this.options.runtime.config
    if (!config.panel.enabled) {
      await this.stop()
      return
    }
    if (config.panel.token !== this.token) {
      this.token = config.panel.token
      this.auth.rotate(config.panel.token)
      this.options.logger.info("面板令牌已更新，已签发的会话全部作废")
    }
    const host = config.panel.host
    const port = config.panel.port
    if (this.listening && this.listening.host === host && this.listening.port === port) return
    await this.stop()
    await this.listen()
  }

  /** 真正开始监听。 */
  private async listen(): Promise<void> {
    const config = this.options.runtime.config
    const host = config.panel.host
    const port = config.panel.port
    const staticDir = panelStaticDir()
    const app = createPanelApp({
      auth: this.auth,
      controller: this.options.controller,
      runtime: this.options.runtime,
      models: this.options.models,
      ...(existsSync(staticDir) ? { staticDir } : {}),
    })
    const server = serve({ fetch: app.fetch, hostname: host, port })
    server.unref?.()
    this.server = server
    this.listening = { host, port }
    this.options.logger.info(`状态面板已启动：http://${host}:${port}`)
    if (!existsSync(staticDir)) {
      this.options.logger.warn("面板前端产物不存在，只有接口可用", "请执行 bun run web:build")
    }
  }
}
