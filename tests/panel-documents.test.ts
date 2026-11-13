import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ConfigController } from "../src/config/live"
import { ConfigStore } from "../src/config/store"
import { type Logger } from "../src/logger"
import { ChatOverrides } from "../src/overrides"
import { createPanelApp } from "../src/panel/api"
import { PanelAuth } from "../src/panel/auth"
import { PanelRuntime } from "../src/panel/runtime"
import { ToolPolicy } from "../src/tools/policy"

const TOKEN = "panel-token-for-tests"
/** 放在配置里的面板令牌：面板不回显它。 */
const PANEL_SECRET = "panel-secret-token-123456"

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

let root: string
let controller: ConfigController
let runtime: PanelRuntime
let app: ReturnType<typeof createPanelApp>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "qq-panel-docs-"))
  const store = new ConfigStore(join(root, "config.json"), logger)
  await store.write({
    napcat: { url: "ws://127.0.0.1:3001", token: "napcat-secret" },
    panel: { token: PANEL_SECRET },
  })
  controller = new ConfigController({ store, logger })
  const config = await controller.load()
  runtime = new PanelRuntime({ config, home: { directory: root }, logger })
  // 运行时句柄：面板保存后要靠它确认新配置已经热加载。
  runtime.overrides = new ChatOverrides(join(root, "chat-overrides.json"), logger)
  runtime.policy = new ToolPolicy(join(root, "tool-profiles.json"), logger)
  app = createPanelApp({
    auth: new PanelAuth(TOKEN),
    controller,
    runtime,
    models: { list: async () => [] },
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 带令牌的请求头。 */
const auth = { Authorization: `Bearer ${TOKEN}` }

/** JSON 写请求。 */
function put(path: string, body: unknown, headers: Record<string, string> = auth) {
  return app.request(path, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** 读一个 JSON 文件。 */
async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
}

describe("独立配置文件的鉴权", () => {
  it("未授权时两个接口都返回 401", async () => {
    expect((await app.request("/api/chat-overrides")).status).toBe(401)
    expect((await app.request("/api/tool-profiles")).status).toBe(401)
    expect((await put("/api/chat-overrides", { chats: {} }, {})).status).toBe(401)
    expect((await put("/api/tool-profiles", { chats: {} }, {})).status).toBe(401)
  })

  it("令牌不对时返回 401", async () => {
    const response = await app.request("/api/chat-overrides", {
      headers: { Authorization: "Bearer wrong" },
    })
    expect(response.status).toBe(401)
  })

  it("跨站的写请求被拒绝", async () => {
    const response = await put(
      "/api/chat-overrides",
      { chats: {} },
      { ...auth, Origin: "http://evil.example" },
    )
    expect(response.status).toBe(403)
  })

  it("带令牌的读请求放行", async () => {
    expect((await app.request("/api/chat-overrides", { headers: auth })).status).toBe(200)
    expect((await app.request("/api/tool-profiles", { headers: auth })).status).toBe(200)
  })
})

describe("会话覆盖", () => {
  it("返回文件位置、生效值与文件值", async () => {
    await writeFile(
      join(root, "chat-overrides.json"),
      JSON.stringify({ chats: { "group:100": { wake: "mention" } } }),
    )
    const response = await app.request("/api/chat-overrides", { headers: auth })
    const body = (await response.json()) as {
      path: string
      exists: boolean
      value: { chats: Record<string, { wake?: string }> }
      fileValue: unknown
    }
    expect(body.path).toBe(join(root, "chat-overrides.json"))
    expect(body.exists).toBe(true)
    expect(body.value.chats["group:100"]?.wake).toBe("mention")
    expect(body.fileValue).toMatchObject({ chats: { "group:100": { wake: "mention" } } })
  })

  it("保存后落盘、权限是 0600、并留下备份", async () => {
    const response = await put("/api/chat-overrides", {
      chats: { "group:100": { wake: "all", agent: "build" } },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { restartRequired: boolean; note: string }
    expect(body.restartRequired).toBe(false)
    expect(body.note).toContain("无需重启")
    const path = join(root, "chat-overrides.json")
    expect(await readJson(path)).toEqual({
      chats: { "group:100": { wake: "all", agent: "build" } },
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    // 再存一次：上一份内容留在 .bak 里。
    await put("/api/chat-overrides", { chats: { "group:100": { wake: "none" } } })
    expect(await readJson(`${path}.bak`)).toEqual({
      chats: { "group:100": { wake: "all", agent: "build" } },
    })
    expect((await stat(`${path}.bak`)).mode & 0o777).toBe(0o600)
  })

  it("保存后运行时立刻用上新的覆盖", async () => {
    await put("/api/chat-overrides", {
      chats: { "private:200": { "proactive.enabled": true } },
    })
    const live = await runtime.overrides?.current()
    expect(live?.chats["private:200"]?.["proactive.enabled"]).toBe(true)
  })

  it("聊天键不合法时给出具体到字段的原因", async () => {
    const response = await put("/api/chat-overrides", { chats: { abc: { wake: "all" } } })
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: string
      fields: Array<{ path: string; message: string }>
    }
    expect(body.error).toBe("validation_failed")
    expect(body.fields[0]?.path).toBe("chats.abc")
    expect(body.fields[0]?.message).toContain("group:")
    // 文件不该被写坏。
    await expect(stat(join(root, "chat-overrides.json"))).rejects.toThrow()
  })

  it("单个字段写错只忽略这一项，其余照常生效", async () => {
    const response = await put("/api/chat-overrides", {
      chats: { "group:100": { wake: "不存在的模式", agent: "build" } },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      warnings: string[]
      document: { value: { chats: Record<string, Record<string, unknown>> } }
    }
    expect(body.warnings.join("；")).toContain("wake")
    expect(body.document.value.chats["group:100"]).toEqual({ agent: "build" })
    expect(await readJson(join(root, "chat-overrides.json"))).toEqual({
      chats: { "group:100": { agent: "build" } },
    })
  })

  it("未知字段被忽略并告警", async () => {
    const response = await put("/api/chat-overrides", {
      chats: { "group:100": { wakee: "all" } },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { warnings: string[] }
    expect(body.warnings.join("；")).toContain("wakee")
  })

  it("可以删掉一个聊天的覆盖", async () => {
    await put("/api/chat-overrides", { chats: { "group:100": { wake: "all" } } })
    const response = await put("/api/chat-overrides", { chats: { "group:100": null } })
    expect(response.status).toBe(200)
    expect(await readJson(join(root, "chat-overrides.json"))).toEqual({ chats: {} })
  })

  it("只提交改动，没提到的字段保持原样", async () => {
    await put("/api/chat-overrides", {
      chats: { "group:100": { wake: "all" }, "private:200": { agent: "build" } },
    })
    await put("/api/chat-overrides", { chats: { "group:100": { agent: "ops" } } })
    expect(await readJson(join(root, "chat-overrides.json"))).toEqual({
      chats: { "group:100": { wake: "all", agent: "ops" }, "private:200": { agent: "build" } },
    })
  })

  it("命中已知凭证的字段不回显", async () => {
    await writeFile(
      join(root, "chat-overrides.json"),
      JSON.stringify({ chats: { "group:100": { soulPath: `/tmp/${PANEL_SECRET}/soul.md` } } }),
    )
    const response = await app.request("/api/chat-overrides", { headers: auth })
    const text = await response.text()
    expect(text).not.toContain(PANEL_SECRET)
    const body = JSON.parse(text) as { masked: string[] }
    expect(body.masked).toContain("chats.group:100.soulPath")
  })
})

describe("工具档案", () => {
  it("返回生效值：内置配置档也在里面", async () => {
    const response = await app.request("/api/tool-profiles", { headers: auth })
    const body = (await response.json()) as {
      path: string
      value: { defaultProfile: string; profiles: Record<string, unknown> }
    }
    expect(body.path).toBe(join(root, "tool-profiles.json"))
    expect(body.value.defaultProfile).toBe("chat")
    expect(Object.keys(body.value.profiles)).toContain("admin")
  })

  it("保存后落盘、权限是 0600、并留下备份", async () => {
    const response = await put("/api/tool-profiles", {
      defaultProfile: "readonly",
      profiles: { readonly: { allow: ["read", "grep"], deny: ["qq_send_file"] } },
      chats: { "group:100": "readonly" },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { restartRequired: boolean; note: string }
    expect(body.restartRequired).toBe(false)
    expect(body.note).toContain("无需重启")
    const path = join(root, "tool-profiles.json")
    expect(await readJson(path)).toEqual({
      defaultProfile: "readonly",
      profiles: { readonly: { allow: ["read", "grep"], deny: ["qq_send_file"] } },
      chats: { "group:100": "readonly" },
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await put("/api/tool-profiles", { defaultProfile: "chat" })
    expect(await readJson(`${path}.bak`)).toMatchObject({ defaultProfile: "readonly" })
  })

  it("保存后运行时立刻用上新的配置", async () => {
    await put("/api/tool-profiles", {
      profiles: { readonly: { allow: ["read"], deny: [] } },
      chats: { "group:100": "readonly" },
    })
    const live = await runtime.policy?.current()
    expect(live?.chats["group:100"]).toBe("readonly")
    expect(live?.profiles.readonly?.allow).toEqual(["read"])
  })

  it("引用不存在的配置档时给出可读的错误", async () => {
    const response = await put("/api/tool-profiles", { chats: { "group:100": "不存在的档" } })
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      fields: Array<{ path: string; message: string }>
    }
    expect(body.fields[0]?.path).toBe("chats.group:100")
    expect(body.fields[0]?.message).toContain("不存在的档")
  })

  it("默认配置档不存在时被拒绝", async () => {
    const response = await put("/api/tool-profiles", { defaultProfile: "没有这一档" })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { fields: Array<{ path: string; message: string }> }
    expect(body.fields[0]?.path).toBe("defaultProfile")
  })

  it("聊天键不合法时被拒绝", async () => {
    const response = await put("/api/tool-profiles", { chats: { "群 100": "chat" } })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { fields: Array<{ path: string }> }
    expect(body.fields[0]?.path).toBe("chats.群 100")
  })

  it("配置档名字不合法时被拒绝", async () => {
    const response = await put("/api/tool-profiles", {
      profiles: { "带 空格的档": { allow: [], deny: [] } },
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { fields: Array<{ path: string }> }
    expect(body.fields[0]?.path).toBe("profiles.带 空格的档")
  })

  it("内置配置档不能删", async () => {
    const response = await put("/api/tool-profiles", { profiles: { admin: null } })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { fields: Array<{ message: string }> }
    expect(body.fields[0]?.message).toContain("内置")
  })

  it("删掉还在被引用的配置档时给出可读的错误", async () => {
    await put("/api/tool-profiles", {
      profiles: { custom: { allow: ["read"], deny: [] } },
      chats: { "group:100": "custom" },
    })
    const response = await put("/api/tool-profiles", { profiles: { custom: null } })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { fields: Array<{ message: string }> }
    expect(body.fields[0]?.message).toContain("custom")
  })

  it("可以删掉自己的配置档与聊天映射", async () => {
    await put("/api/tool-profiles", {
      profiles: { custom: { allow: ["read"], deny: [] } },
      chats: { "group:100": "custom" },
    })
    const response = await put("/api/tool-profiles", {
      profiles: { custom: null },
      chats: { "group:100": null },
    })
    expect(response.status).toBe(200)
    expect(await readJson(join(root, "tool-profiles.json"))).toMatchObject({
      profiles: {},
      chats: {},
    })
  })

  it("工具列表写错时只丢掉这一项并告警", async () => {
    const response = await put("/api/tool-profiles", {
      profiles: { readonly: { allow: ["read", 42], deny: [] } },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      warnings: string[]
      document: { value: { profiles: Record<string, { allow: string[] }> } }
    }
    expect(body.warnings.join("；")).toContain("allow")
    expect(body.document.value.profiles.readonly?.allow).toEqual(["read"])
  })
})
