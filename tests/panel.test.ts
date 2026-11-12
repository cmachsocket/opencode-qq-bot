import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ConfigController } from "../src/config/live"
import { ConfigStore } from "../src/config/store"
import { createLogger, type Logger } from "../src/logger"
import { createPanelApp } from "../src/panel/api"
import { PanelAuth } from "../src/panel/auth"
import { PanelRuntime } from "../src/panel/runtime"

const TOKEN = "panel-token-for-tests"

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

let root: string
let controller: ConfigController
let app: ReturnType<typeof createPanelApp>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "qq-panel-"))
  const store = new ConfigStore(join(root, "config.json"), logger)
  await store.write({
    napcat: { url: "ws://127.0.0.1:3001", token: "napcat-secret" },
    access: { allow: { groups: [123] } },
  })
  controller = new ConfigController({ store, logger })
  const config = await controller.load()
  const runtime = new PanelRuntime({ config, home: { directory: root }, logger })
  app = createPanelApp({
    auth: new PanelAuth(TOKEN),
    controller,
    runtime,
    models: {
      list: async () => [
        { providerID: "openai", id: "gpt-5", name: "GPT-5", default: true },
        { providerID: "anthropic", id: "claude", name: "Claude", default: false },
      ],
    },
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 带令牌的请求头。 */
const auth = { Authorization: `Bearer ${TOKEN}` }

describe("鉴权", () => {
  it("未授权时返回 401", async () => {
    const response = await app.request("/api/config")
    expect(response.status).toBe(401)
  })

  it("令牌不对时返回 401", async () => {
    const response = await app.request("/api/config", {
      headers: { Authorization: "Bearer wrong-token" },
    })
    expect(response.status).toBe(401)
  })

  it("Bearer 令牌可以读接口", async () => {
    const response = await app.request("/api/config", { headers: auth })
    expect(response.status).toBe(200)
  })

  it("用令牌换会话 Cookie，之后自动带上", async () => {
    const login = await app.request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get("set-cookie") ?? ""
    expect(cookie).toContain("qqbot_session=")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Strict")
    const value = cookie.split(";")[0] ?? ""
    const response = await app.request("/api/config", { headers: { Cookie: value } })
    expect(response.status).toBe(200)
  })

  it("令牌不对时换不到 Cookie", async () => {
    const login = await app.request("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "nope" }),
    })
    expect(login.status).toBe(401)
    expect(login.headers.get("set-cookie")).toBeNull()
  })
})

describe("CSRF", () => {
  it("跨站的写请求被拒绝", async () => {
    const response = await app.request("/api/config", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ "rateLimit.maxPerMinute": 3 }),
    })
    expect(response.status).toBe(403)
  })

  it("同源的写请求放行", async () => {
    const response = await app.request("/api/config", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ "rateLimit.maxPerMinute": 3 }),
    })
    expect(response.status).toBe(200)
  })
})

describe("配置接口", () => {
  it("schema 返回字段元数据与 JSON Schema", async () => {
    const response = await app.request("/api/config/schema", { headers: auth })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      fields: Array<{ path: string; type: string }>
      jsonSchema: { type: string }
    }
    expect(body.fields.some((field) => field.path === "rateLimit.maxPerMinute")).toBe(true)
    expect(body.jsonSchema.type).toBe("object")
  })

  it("config 返回生效值、文件值与来源", async () => {
    const response = await app.request("/api/config", { headers: auth })
    const body = (await response.json()) as {
      fields: Array<{
        path: string
        value?: unknown
        source: string
        secret: boolean
        hasValue?: boolean
      }>
    }
    const limit = body.fields.find((field) => field.path === "rateLimit.maxPerMinute")
    expect(limit?.value).toBe(8)
    expect(limit?.source).toBe("default")
    const allow = body.fields.find((field) => field.path === "access.allow.groups")
    expect(allow?.value).toEqual([123])
    expect(allow?.source).toBe("file")
  })

  it("敏感字段不回显明文", async () => {
    const response = await app.request("/api/config", { headers: auth })
    const body = (await response.json()) as { fields: Array<Record<string, unknown>> }
    const token = body.fields.find((field) => field.path === "napcat.token")
    expect(token?.hasValue).toBe(true)
    expect(token?.value).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain("napcat-secret")
  })

  it("提交变更会落盘并立即生效", async () => {
    const response = await app.request("/api/config", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ "rateLimit.maxPerMinute": 3, "napcat.url": "ws://127.0.0.1:4001" }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { restartRequired: string[] }
    expect(body.restartRequired).toEqual(["napcat.url"])
    const saved = JSON.parse(await readFile(join(root, "config.json"), "utf8")) as Record<
      string,
      unknown
    >
    expect(saved).toMatchObject({ rateLimit: { maxPerMinute: 3 } })
    expect(controller.current?.rateLimit.maxPerMinute).toBe(3)
  })

  it("取值不合法时返回具体到字段的原因", async () => {
    const response = await app.request("/api/config", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ "rateLimit.maxPerMinute": -1 }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string; fields: Array<{ path: string }> }
    expect(body.error).toBe("validation_failed")
    expect(body.fields[0]?.path).toBe("rateLimit.maxPerMinute")
  })

  it("未知配置项被拒绝", async () => {
    const response = await app.request("/api/config", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ "nope.value": 1 }),
    })
    expect(response.status).toBe(400)
  })

  it("只接受 JSON 请求体", async () => {
    const response = await app.request("/api/config", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/xml" },
      body: "<config/>",
    })
    expect(response.status).toBe(415)
  })

  it("表单类请求体会被 CSRF 校验挡下", async () => {
    const response = await app.request("/api/config", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: "rateLimit.maxPerMinute=3",
    })
    expect(response.status).toBe(403)
  })
})

describe("SSE", () => {
  it("订阅后先推送状态，连接保持到客户端断开", async () => {
    const response = await app.request("/api/stream", { headers: auth })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const first = await reader?.read()
    const text = new TextDecoder().decode(first?.value)
    expect(text).toContain("event: status")
    await reader?.cancel()
  })
})

describe("其它接口", () => {
  it("models 返回 OpenCode 的可用模型", async () => {
    const response = await app.request("/api/models", { headers: auth })
    const body = (await response.json()) as {
      models: Array<{ providerID: string; id: string; default: boolean }>
    }
    expect(body.models).toHaveLength(2)
    expect(body.models[0]?.default).toBe(true)
  })

  it("status 返回运行状态快照", async () => {
    const response = await app.request("/api/status", { headers: auth })
    const body = (await response.json()) as {
      version: string
      connection: { connected: boolean }
      sessions: unknown[]
      runtime: { home: string }
    }
    expect(body.version).toBeTypeOf("string")
    expect(body.connection.connected).toBe(false)
    expect(body.sessions).toEqual([])
    expect(body.runtime.home).toBe(root)
  })

  it("logs 返回内存里的日志尾部", async () => {
    const test = createLogger("[panel-test]", { file: false })
    test.info("面板测试日志")
    const response = await app.request("/api/logs?limit=10", { headers: auth })
    const body = (await response.json()) as { entries: Array<{ message: string; level: string }> }
    expect(body.entries.some((entry) => entry.message === "面板测试日志")).toBe(true)
  })

  it("logs 可以按级别过滤", async () => {
    const test = createLogger("[panel-test]", { file: false })
    test.warn("只该出现在 warn 里")
    const response = await app.request("/api/logs?level=error", { headers: auth })
    const body = (await response.json()) as { entries: Array<{ message: string }> }
    expect(body.entries.some((entry) => entry.message === "只该出现在 warn 里")).toBe(false)
  })
})
