import { createAdaptorServer, type ServerType } from "@hono/node-server"
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
  /** 端口被占用时的重试次数与间隔（毫秒）。 */
  retry?: { times: number; intervalMs: number }
}

/** 前端构建产物目录。 */
export function panelStaticDir(): string {
  return join(packageRoot, "web", "dist")
}

/** 端口被占用时的重试次数与间隔（毫秒）。 */
const PORT_RETRY_TIMES = 5
const PORT_RETRY_INTERVAL_MS = 500

export class PanelServer {
  private server: ServerType | undefined
  private auth: PanelAuth
  /** 鉴权当前认的令牌。 */
  private token: string
  private unsubscribe: (() => void) | undefined
  /** 当前监听的地址与端口。 */
  private listening: { host: string; port: number } | undefined
  /** 端口被占用时的重试策略。 */
  private readonly retry: { times: number; intervalMs: number }

  constructor(private readonly options: PanelServerOptions) {
    this.token = options.runtime.config.panel.token
    this.auth = new PanelAuth(this.token)
    this.retry = options.retry ?? { times: PORT_RETRY_TIMES, intervalMs: PORT_RETRY_INTERVAL_MS }
  }

  /** 令牌与会话管理。 */
  get sessions(): PanelAuth {
    return this.auth
  }

  /**
   * 启动服务。
   *
   * 订阅配置变化与面板是否启用无关：启用、地址、端口都由配置决定，
   * 面板关着的时候也得盯着配置，改成启用之后要能自己起来。
   */
  async start(): Promise<void> {
    this.unsubscribe ??= this.options.controller.onChange(() => {
      void this.reconcile()
    })
    await this.reconcile()
  }

  /** 停止服务：退订配置变化并关闭 HTTP 服务。 */
  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    await this.closeServer()
  }

  /** 配置变了：令牌、是否启用、地址或端口都要跟着调整。 */
  private async reconcile(): Promise<void> {
    const config = this.options.runtime.config
    // 令牌先换：面板关着的时候换了令牌，启用后也要认新的。
    if (config.panel.token !== this.token) {
      this.token = config.panel.token
      this.auth.rotate(config.panel.token)
      this.options.logger.info("面板令牌已更新，已签发的会话全部作废")
    }
    if (!config.panel.enabled) {
      await this.closeServer()
      return
    }
    const host = config.panel.host
    const port = config.panel.port
    if (this.listening && this.listening.host === host && this.listening.port === port) return
    await this.closeServer()
    await this.listen()
  }

  /** 关掉 HTTP 服务。 */
  private async closeServer(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.listening = undefined
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // SSE 的连接不会自己断，close 会一直等；强制掐掉，免得卸载卡住。
      if ("closeAllConnections" in server) server.closeAllConnections()
    })
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
    const server = await this.bind(app, host, port)
    server.on("error", (error: Error) => {
      this.options.logger.error("状态面板服务出错", error)
    })
    server.unref?.()
    this.server = server
    this.listening = { host, port }
    this.options.logger.info(`状态面板已启动：http://${host}:${port}`)
    if (!existsSync(staticDir)) {
      this.options.logger.warn("面板前端产物不存在，只有接口可用", "请执行 bun run web:build")
    }
  }

  /**
   * 监听端口。
   *
   * 端口被占用时 `http.Server` 是异步抛错的，不显式接住就会变成未捕获异常
   * 把整个进程带下去；这里自己接住并重试：上一个实例刚退出时端口还没释放，
   * 等一下就能接上。
   */
  private async bind(app: ReturnType<typeof createPanelApp>, host: string, port: number) {
    for (let attempt = 0; ; attempt++) {
      const server = createAdaptorServer({ fetch: app.fetch, hostname: host })
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => {
            server.off("listening", onListening)
            reject(error)
          }
          const onListening = () => {
            server.off("error", onError)
            resolve()
          }
          server.once("error", onError)
          server.once("listening", onListening)
          server.listen(port, host)
        })
        return server
      } catch (error) {
        server.close()
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "EADDRINUSE" || attempt >= this.retry.times) throw error
        this.options.logger.warn(
          `面板端口 ${host}:${port} 被占用，稍后重试（${attempt + 1}/${this.retry.times}）`,
        )
        await delay(this.retry.intervalMs)
      }
    }
  }
}

/** 等一会儿再继续。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
