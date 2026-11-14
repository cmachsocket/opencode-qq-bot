import { mkdtemp, readFile, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ConfigController } from "../src/config/live"
import { ConfigStore } from "../src/config/store"
import type { Logger } from "../src/logger"
import { PanelServer } from "../src/panel/server"
import { PanelRuntime } from "../src/panel/runtime"

const TOKEN = "panel-token-for-tests"

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** 找一个没人占用的端口。 */
async function freePort(): Promise<number> {
  const { createServer } = await import("node:http")
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

let root: string
let controller: ConfigController
let store: ConfigStore
let runtime: PanelRuntime
let servers: PanelServer[] = []

/** 起一个面板服务。 */
function createServer(port: number, retry?: { times: number; intervalMs: number }): PanelServer {
  const server = new PanelServer({
    controller,
    runtime,
    models: { list: async () => [] },
    logger,
    ...(retry ? { retry } : {}),
  })
  servers.push(server)
  return server
}

/** 用给定内容另起一套配置，顺便把运行时指过去。 */
async function createController(
  content: Record<string, unknown>,
): Promise<{ controller: ConfigController; path: string }> {
  const path = join(root, `config-${randomUUID()}.json`)
  const ownStore = new ConfigStore(path, logger)
  await ownStore.write(content)
  const own = new ConfigController({ store: ownStore, logger })
  const loaded = await own.load()
  runtime = new PanelRuntime({ config: loaded, home: { directory: root }, logger })
  return { controller: own, path }
}

/** 取配置里的面板令牌。 */
function panelToken(source: ConfigController): string {
  const raw = source.file as { panel?: { token?: string } }
  return raw.panel?.token ?? ""
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "qq-panel-server-"))
  store = new ConfigStore(join(root, "config.json"), logger)
  await store.write({
    napcat: { url: "ws://127.0.0.1:3001", token: "napcat-secret" },
    access: { allow: { groups: [123] } },
    panel: { enabled: true, host: "127.0.0.1", port: 0, token: TOKEN },
  })
  controller = new ConfigController({ store, logger })
  const config = await controller.load()
  runtime = new PanelRuntime({ config, home: { directory: root }, logger })
})

afterEach(async () => {
  for (const server of servers) {
    await server.stop().catch(() => {})
  }
  servers = []
  await rm(root, { recursive: true, force: true })
})

describe("面板服务的生命周期", () => {
  it("端口被占用时启动失败，但不抛未捕获异常", async () => {
    const port = await freePort()
    const first = createServer(port)
    await first.start()

    const second = createServer(port, { times: 0, intervalMs: 0 })
    await expect(second.start()).rejects.toMatchObject({ code: "EADDRINUSE" })
  })

  it("端口被占用时重试，等端口释放就能起起来", async () => {
    const port = await freePort()
    const first = createServer(port)
    await first.start()

    const second = createServer(port, { times: 10, intervalMs: 50 })
    const pending = second.start()
    setTimeout(() => {
      void first.stop()
    }, 100)
    await expect(pending).resolves.toBeUndefined()
  })

  it("默认关闭时不监听端口", async () => {
    const port = await freePort()
    await controller.applyPatch({ "panel.enabled": false, "panel.port": port })
    const server = createServer(port)
    await server.start()
    await expect(fetch(`http://127.0.0.1:${port}/api/status`)).rejects.toThrow()
  })

  it("关闭状态下改配置打开面板，端口会被监听", async () => {
    const port = await freePort()
    await controller.applyPatch({ "panel.enabled": false, "panel.port": port })
    const server = createServer(port)
    await server.start()

    await controller.applyPatch({ "panel.enabled": true })
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      return response.status === 200
    })
  })

  it("换端口之后仍然响应配置变化", async () => {
    const first = await freePort()
    const second = await freePort()
    await controller.applyPatch({ "panel.port": first })
    const server = createServer(first)
    await server.start()

    await controller.applyPatch({ "panel.port": second })
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${second}/api/status`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      return response.status === 200
    })

    // 换端口之后令牌照样能换：订阅没被换端口的动作拆掉。
    await controller.applyPatch({ "panel.token": "rotated-token" })
    const ok = await fetch(`http://127.0.0.1:${second}/api/status`, {
      headers: { Authorization: "Bearer rotated-token" },
    })
    expect(ok.status).toBe(200)
    const stale = await fetch(`http://127.0.0.1:${second}/api/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(stale.status).toBe(401)
  })

  it("停止服务之后端口不再响应", async () => {
    const port = await freePort()
    await controller.applyPatch({ "panel.port": port })
    const server = createServer(port)
    await server.start()
    const before = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(before.status).toBe(200)

    await server.stop()
    await expect(
      fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    ).rejects.toThrow()
  })

  it("换到一个被占用的端口时，旧服务继续可用", async () => {
    const first = await freePort()
    const second = await freePort()
    await controller.applyPatch({ "panel.port": first })
    const server = createServer(first, { times: 0, intervalMs: 0 })
    await server.start()

    const { createServer: createHttp } = await import("node:http")
    const blocker = createHttp()
    await new Promise<void>((resolve) => blocker.listen(second, "127.0.0.1", resolve))
    try {
      await controller.applyPatch({ "panel.port": second })
      await wait(300)
      // 旧端口照常响应：换端口失败不能把面板关掉。
      const response = await fetch(`http://127.0.0.1:${first}/api/status`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      expect(response.status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })
})

describe("面板默认开启", () => {
  it("配置里没写面板时默认开启，并自动生成令牌", async () => {
    const port = await freePort()
    const own = await createController({
      napcat: { url: "ws://127.0.0.1:3001" },
      access: { allow: { groups: [123] } },
      panel: { port },
    })
    expect(own.controller.current?.panel.enabled).toBe(true)

    const token = panelToken(own.controller)
    expect(token.length).toBeGreaterThan(0)
    // 令牌写回了配置文件，重启后不变。
    const onDisk = JSON.parse(await readFile(own.path, "utf8")) as { panel?: { token?: string } }
    expect(onDisk.panel?.token).toBe(token)

    const server = createServer(port)
    await server.start()
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
  })

  it("打开面板时会补一个令牌", async () => {
    const port = await freePort()
    await controller.applyPatch({ "panel.enabled": false, "panel.port": port, "panel.token": null })
    const server = createServer(port)
    await server.start()

    await controller.applyPatch({ "panel.enabled": true })
    await waitFor(async () => {
      const token = panelToken(controller)
      if (!token) return false
      const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return response.status === 200
    })
  })
})

describe("令牌吊销", () => {
  it("吊销后面板不再对外服务，也不会自动补新令牌", async () => {
    const port = await freePort()
    await controller.applyPatch({ "panel.port": port })
    const server = createServer(port)
    await server.start()

    await controller.applyPatch({ "panel.tokenRevoked": true })

    // 面板不再响应：吊销的语义是「这个令牌永远不能用」。
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
        return response.status !== 200
      } catch {
        return true
      }
    })
    // 旧令牌也被清掉了，不会再自动补一个新的。
    expect(panelToken(controller)).toBe("")
    await controller.applyPatch({ "panel.tokenRevoked": false })
    await waitFor(async () => panelToken(controller).length > 0)
  })

  it("写入新令牌就是恢复使用", async () => {
    await controller.applyPatch({ "panel.tokenRevoked": true })
    expect(controller.current?.panel.tokenRevoked).toBe(true)

    await controller.applyPatch({ "panel.token": "another-panel-token-value" })

    expect(controller.current?.panel.tokenRevoked).toBe(false)
    expect(panelToken(controller)).toBe("another-panel-token-value")
  })
})

describe("配置文件写坏了", () => {
  it("删掉必填项会被拒绝，文件保持原样", async () => {
    const before = await store.read()
    await expect(controller.applyPatch({ "napcat.url": null })).rejects.toThrow(/必填/)
    expect(await store.read()).toEqual(before)
  })

  it("改完之后配置装不起来时，文件保持原样", async () => {
    const before = await store.read()
    await expect(
      controller.applyPatch({ napcat: { url: null } as unknown as Record<string, unknown> }),
    ).rejects.toThrow()
    expect(await store.read()).toEqual(before)
  })
})

/** 等条件成立。 */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("等待超时")
}

/** 等一会儿。 */
async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
