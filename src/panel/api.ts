import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import { csrf } from "hono/csrf"
import { secureHeaders } from "hono/secure-headers"
import { streamSSE } from "hono/streaming"
import type { ConfigController } from "../config/live"
import { CONFIG_FIELDS, CONFIG_GROUPS } from "../config/fields"
import {
  configJsonSchema,
  createStrictFieldSchema,
  getConfigValue,
  requiredFieldProblem,
} from "../config/registry"
import { readLogTail, subscribeLogs, type LogEntry } from "../logger"
import { PanelAuth, SESSION_COOKIE } from "./auth"
import {
  readChatOverrides,
  readToolProfiles,
  saveChatOverrides,
  saveToolProfiles,
} from "./documents"
import type { ModelProvider } from "./models"
import { collectStatus } from "./status"
import type { PanelRuntime } from "./runtime"

/**
 * 面板的 HTTP 接口。
 *
 * 鉴权两条路：`Authorization: Bearer <token>` 供命令行与 curl 用，
 * 浏览器先 `POST /api/login` 换会话 Cookie，之后自动带上。
 */

/** 安全的方法：不需要 CSRF 校验。 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/** 面板应用的依赖。 */
export interface PanelAppOptions {
  /** 令牌与会话管理。 */
  auth: PanelAuth
  /** 配置控制器：读写与热更新都走它。 */
  controller: ConfigController
  /** 运行时句柄。 */
  runtime: PanelRuntime
  /** 可用模型列表。 */
  models: ModelProvider
  /** 前端构建产物目录；没有就不托管静态资源。 */
  staticDir?: string
}

/** 状态推送的间隔（毫秒）。 */
const STATUS_INTERVAL_MS = 2000

/** 单个配置项在接口里的样子。 */
interface ConfigFieldView {
  /** 配置路径。 */
  path: string
  /** 生效值；敏感字段没有这一项。 */
  value?: unknown
  /** 文件里写的值；敏感字段没有这一项。 */
  fileValue?: unknown
  /** 值来自哪里：`file` 或 `default`。 */
  source: "file" | "default"
  /** 是否敏感字段。 */
  secret: boolean
  /** 是否热更新。 */
  hot: boolean
  /** 敏感字段只给这个：有没有值。 */
  hasValue?: boolean
}

/** 构造面板应用。 */
export function createPanelApp(options: PanelAppOptions): Hono {
  const app = new Hono()
  const { auth, controller, runtime } = options

  // 静态资源带安全响应头：面板是本地工具，但浏览器照样要按 CSP 走。
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
      // 面板走本机 http，HSTS 没有意义。
      strictTransportSecurity: false,
    }),
  )

  // 写接口校验 Origin：带 Origin 的请求必须同源。
  // 带会话 Cookie 的请求必须带 Origin：Cookie 会被浏览器自动带上，
  // 没有 Origin 的请求才可能是脚本伪造的。Bearer 令牌走命令行，不带 Origin 是正常的。
  app.use("/api/*", async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return await next()
    const origin = c.req.header("Origin")
    let expected = ""
    try {
      expected = new URL(c.req.url).origin
    } catch {
      expected = ""
    }
    if (origin) {
      if (origin !== expected) {
        return c.json({ error: "forbidden", message: "跨站请求已被拒绝" }, 403)
      }
    } else if (getCookie(c, SESSION_COOKIE)) {
      return c.json({ error: "forbidden", message: "缺少 Origin 头，请求已被拒绝" }, 403)
    }
    return await next()
  })
  // 表单类内容类型再过一遍 hono 自带的 CSRF 校验。
  app.use("/api/*", csrf({ origin: (origin, c) => origin === new URL(c.req.url).origin }))

  // 鉴权：Bearer 令牌或会话 Cookie。
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/login") return await next()
    const header = c.req.header("Authorization")
    if (header?.startsWith("Bearer ")) {
      if (auth.matches(header.slice("Bearer ".length).trim())) return await next()
      return c.json({ error: "unauthorized", message: "令牌不正确" }, 401)
    }
    if (auth.valid(getCookie(c, SESSION_COOKIE))) return await next()
    return c.json({ error: "unauthorized", message: "未授权：请先登录" }, 401)
  })

  // 用令牌换会话 Cookie。
  app.post("/api/login", async (c) => {
    const body = await readJson(c.req.raw)
    const token =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).token
        : undefined
    if (typeof token !== "string" || !auth.matches(token)) {
      return c.json({ error: "invalid_token", message: "令牌不正确" }, 401)
    }
    setCookie(c, SESSION_COOKIE, auth.issue(), {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    })
    return c.json({ ok: true })
  })

  // 字段元数据与 JSON Schema：前端据此渲染表单。
  app.get("/api/config/schema", (c) => {
    return c.json({
      version: 1,
      groups: CONFIG_GROUPS,
      fields: CONFIG_FIELDS,
      jsonSchema: configJsonSchema(),
    })
  })

  // 生效值、文件值与每字段来源。
  app.get("/api/config", (c) => {
    return c.json({ fields: configView(controller) })
  })

  // 提交变更：后端用同一份规则校验后落盘。
  app.put("/api/config", async (c) => {
    const contentType = c.req.header("Content-Type") ?? ""
    if (!contentType.toLowerCase().includes("application/json")) {
      return c.json({ error: "unsupported_media_type", message: "只接受 JSON 请求体" }, 415)
    }
    const body = await readJson(c.req.raw)
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "invalid_body", message: "请求体必须是一个 JSON 对象" }, 400)
    }
    const patch = body as Record<string, unknown>
    const problems = validatePatch(patch)
    if (problems.length > 0) {
      return c.json(
        { error: "validation_failed", message: "配置校验不通过", fields: problems },
        400,
      )
    }
    try {
      const result = await controller.applyPatch(patch)
      return c.json({
        ok: true,
        restartRequired: result.restartRequired,
        fields: configView(controller),
      })
    } catch (error) {
      return c.json(
        {
          error: "write_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        500,
      )
    }
  })

  // 会话覆盖文件：生效值、文件值与告警。
  app.get("/api/chat-overrides", async (c) => {
    return c.json(await readChatOverrides(runtime))
  })

  // 保存会话覆盖：稀疏改动，校验在服务端做。
  app.put("/api/chat-overrides", async (c) => {
    const contentType = c.req.header("Content-Type") ?? ""
    if (!contentType.toLowerCase().includes("application/json")) {
      return c.json({ error: "unsupported_media_type", message: "只接受 JSON 请求体" }, 415)
    }
    const body = await readJson(c.req.raw)
    const { problems, result } = await saveChatOverrides(runtime, body)
    if (!result) {
      return c.json(
        { error: "validation_failed", message: "会话覆盖校验不通过", fields: problems },
        400,
      )
    }
    return c.json({ ok: true, ...result })
  })

  // 工具配置文件：生效值、文件值与告警。
  app.get("/api/tool-profiles", async (c) => {
    return c.json(await readToolProfiles(runtime))
  })

  // 保存工具配置：稀疏改动，校验在服务端做。
  app.put("/api/tool-profiles", async (c) => {
    const contentType = c.req.header("Content-Type") ?? ""
    if (!contentType.toLowerCase().includes("application/json")) {
      return c.json({ error: "unsupported_media_type", message: "只接受 JSON 请求体" }, 415)
    }
    const body = await readJson(c.req.raw)
    const { problems, result } = await saveToolProfiles(runtime, body)
    if (!result) {
      return c.json(
        { error: "validation_failed", message: "工具配置校验不通过", fields: problems },
        400,
      )
    }
    return c.json({ ok: true, ...result })
  })

  // 可用模型列表。
  app.get("/api/models", async (c) => {
    try {
      return c.json({ models: await options.models.list() })
    } catch (error) {
      return c.json(
        { error: "models_failed", message: error instanceof Error ? error.message : String(error) },
        502,
      )
    }
  })

  // 运行状态快照。
  app.get("/api/status", async (c) => {
    return c.json(await collectStatus(runtime))
  })

  // 日志尾部。
  app.get("/api/logs", (c) => {
    const limit = Number(c.req.query("limit") ?? "200")
    const level = c.req.query("level")
    const entries = readLogTail({
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(level === "debug" || level === "info" || level === "warn" || level === "error"
        ? { level }
        : {}),
    })
    return c.json({ entries })
  })

  // SSE：状态、配置变更与日志推送。
  app.get("/api/stream", (c) => {
    return streamSSE(c, async (stream) => {
      let alive = true
      const write = async (event: string, data: unknown) => {
        if (!alive) return
        try {
          await stream.writeSSE({ event, data: JSON.stringify(data) })
        } catch {
          alive = false
        }
      }
      const unsubscribeLogs = subscribeLogs((entry: LogEntry) => {
        void write("log", entry)
      })
      const unsubscribeConfig = controller.onChange(() => {
        void write("config", { fields: configView(controller) })
      })
      const timer = setInterval(() => {
        void collectStatus(runtime)
          .then((status) => write("status", status))
          .catch(() => undefined)
      }, STATUS_INTERVAL_MS)
      timer.unref?.()
      const close = () => {
        alive = false
        clearInterval(timer)
        unsubscribeLogs()
        unsubscribeConfig()
      }
      stream.onAbort(close)
      await write("status", await collectStatus(runtime))
      // 保持连接，直到客户端断开；`onAbort` 负责清理计时器与订阅。
      while (alive) await stream.sleep(1000)
      close()
    })
  })

  // 静态资源与单页应用。
  if (options.staticDir) {
    const root = options.staticDir
    app.use("/*", serveStatic({ root, rewriteRequestPath: (path) => path }))
    app.notFound(async (c) => {
      if (c.req.path.startsWith("/api/")) {
        return c.json({ error: "not_found", message: "接口不存在" }, 404)
      }
      const index = join(root, "index.html")
      try {
        const html = await readFile(index, "utf8")
        return c.html(html)
      } catch {
        return c.text("前端构建产物不存在：请先执行 bun run web:build", 404)
      }
    })
  }

  return app
}

/** 读取 JSON 请求体；解析失败返回 undefined。 */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

/** 逐字段的生效值视图。 */
function configView(controller: ConfigController): ConfigFieldView[] {
  const config = controller.current
  const raw = controller.file
  return CONFIG_FIELDS.map((field) => {
    const value = config ? getConfigValue(config, field.path) : undefined
    const fileValue = getConfigValue(raw, field.path)
    const fromFile = fileValue !== undefined
    const base = {
      path: field.path,
      source: fromFile ? ("file" as const) : ("default" as const),
      secret: field.secret === true,
      hot: field.hot === true,
    }
    if (field.secret) {
      const hasValue =
        typeof value === "string" ? value.length > 0 : value !== undefined && value !== null
      return { ...base, hasValue }
    }
    return {
      ...base,
      value,
      ...(fromFile ? { fileValue } : {}),
    }
  })
}

/** 校验稀疏补丁：字段必须存在，值必须合法。 */
function validatePatch(patch: Record<string, unknown>): Array<{ path: string; message: string }> {
  const problems: Array<{ path: string; message: string }> = []
  for (const [path, value] of Object.entries(patch)) {
    const field = CONFIG_FIELDS.find((entry) => entry.path === path)
    if (!field) {
      problems.push({ path, message: "未知配置项" })
      continue
    }
    if (value === null) {
      const problem = requiredFieldProblem(path, value)
      if (problem) problems.push({ path, message: problem })
      continue
    }
    const schema = createStrictFieldSchema(field)
    const result = schema.safeParse(value)
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => issue.message)
        .filter((text) => text.length > 0)
        .join("；")
      problems.push({ path, message: message.length > 0 ? message : "取值不合法" })
    }
  }
  return problems
}
