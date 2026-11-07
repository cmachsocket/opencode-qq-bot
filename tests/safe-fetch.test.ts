import { afterAll, beforeAll, describe, expect, it } from "vitest"
import http from "node:http"
import { useAgent } from "request-filtering-agent"
import { ALLOWED_PORTS, safeFetchBytes } from "../src/safe-fetch"
import type { Logger } from "../src/logger"

const warnings: string[] = []
const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (message: string) => {
    warnings.push(message)
  },
  error: () => {},
}

/** 记录收到的请求路径，用来断言请求根本没发出去。 */
let hits: string[] = []
let server: http.Server
let port = 0

beforeAll(async () => {
  server = http.createServer((request, response) => {
    hits.push(request.url ?? "")
    const path = request.url ?? ""
    if (path === "/ok") {
      response.writeHead(200, { "content-type": "image/png" })
      response.end(Buffer.from([1, 2, 3, 4]))
      return
    }
    if (path === "/big") {
      response.writeHead(200, { "content-type": "image/png", "content-length": "1024" })
      response.end(Buffer.alloc(1024, 7))
      return
    }
    if (path === "/stream") {
      // 不带 content-length，靠分块把体积撑过上限。
      response.writeHead(200, { "content-type": "image/png" })
      for (let index = 0; index < 8; index += 1) response.write(Buffer.alloc(1024, 9))
      response.end()
      return
    }
    if (path === "/404") {
      response.writeHead(404)
      response.end("nope")
      return
    }
    if (path === "/redirect") {
      response.writeHead(302, { location: "/ok" })
      response.end()
      return
    }
    // /slow 故意不回应，用来验证超时。
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** 放行回环地址的 agent：只有测试需要，生产路径一律用默认的过滤 agent。 */
const permissiveAgent = (href: string) => useAgent(href, { allowIPAddressList: ["127.0.0.1"] })

describe("safeFetchBytes 的地址判定", () => {
  it("拒绝指向回环地址的请求", async () => {
    hits = []
    const result = await safeFetchBytes(new URL(`http://127.0.0.1:${port}/ok`), {
      maxBytes: 1024,
      timeoutMs: 2000,
      logger,
    })
    expect(result).toBeUndefined()
    expect(hits).toEqual([])
  })

  it("拒绝内网与保留地址", async () => {
    const hosts = [
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.1.1",
      "198.18.0.1",
      "169.254.169.254",
      "[::1]",
      "[::ffff:127.0.0.1]",
      "[64:ff9b::7f00:1]",
      "[2002:7f00:1::]",
      "[fc00::1]",
      "[fe80::1]",
      "0.0.0.0",
    ]
    for (const host of hosts) {
      const result = await safeFetchBytes(new URL(`http://${host}/ok`), {
        maxBytes: 1024,
        timeoutMs: 2000,
        logger,
      })
      expect(result, host).toBeUndefined()
    }
  })

  it("拒绝非 http(s) 协议", async () => {
    const result = await safeFetchBytes(new URL("file:///etc/passwd"), {
      maxBytes: 1024,
      timeoutMs: 2000,
      logger,
    })
    expect(result).toBeUndefined()
  })

  it("拒绝不在白名单里的端口", async () => {
    hits = []
    const result = await safeFetchBytes(new URL(`http://127.0.0.1:${port}/ok`), {
      maxBytes: 1024,
      timeoutMs: 2000,
      logger,
      agentFor: permissiveAgent,
    })
    expect(result).toBeUndefined()
    expect(hits).toEqual([])
  })
})

describe("safeFetchBytes 的下载行为", () => {
  it("白名单端口正常下载", async () => {
    hits = []
    const result = await safeFetchBytes(new URL(`http://127.0.0.1:${port}/ok`), {
      maxBytes: 1024,
      timeoutMs: 2000,
      logger,
      allowedPorts: [port],
      agentFor: permissiveAgent,
    })
    expect(result?.status).toBe(200)
    expect(result?.contentType).toBe("image/png")
    expect([...(result?.bytes ?? [])]).toEqual([1, 2, 3, 4])
    expect(hits).toEqual(["/ok"])
  })

  it("默认端口白名单只放行网页端口", () => {
    expect([...ALLOWED_PORTS]).toEqual([80, 443, 8080, 8443])
  })

  it("响应体超过上限时中断", async () => {
    const result = await safeFetchBytes(new URL(`http://127.0.0.1:${port}/big`), {
      maxBytes: 16,
      timeoutMs: 2000,
      logger,
      allowedPorts: [port],
      agentFor: permissiveAgent,
    })
    expect(result).toBeUndefined()
  })

  it("没有 content-length 时按实际流量中断", async () => {
    const result = await safeFetchBytes(new URL(`http://127.0.0.1:${port}/stream`), {
      maxBytes: 1024,
      timeoutMs: 2000,
      logger,
      allowedPorts: [port],
      agentFor: permissiveAgent,
    })
    expect(result).toBeUndefined()
  })

  it("非 2xx 视为失败", async () => {
    const result = await safeFetchBytes(new URL(`http://127.0.0.1:${port}/404`), {
      maxBytes: 1024,
      timeoutMs: 2000,
      logger,
      allowedPorts: [port],
      agentFor: permissiveAgent,
    })
    expect(result).toBeUndefined()
  })

  it("不跟随跳转", async () => {
    hits = []
    const result = await safeFetchBytes(new URL(`http://127.0.0.1:${port}/redirect`), {
      maxBytes: 1024,
      timeoutMs: 2000,
      logger,
      allowedPorts: [port],
      agentFor: permissiveAgent,
    })
    expect(result).toBeUndefined()
    expect(hits).toEqual(["/redirect"])
  })

  it("超时就放弃", async () => {
    const result = await safeFetchBytes(new URL(`http://127.0.0.1:${port}/slow`), {
      maxBytes: 1024,
      timeoutMs: 200,
      logger,
      allowedPorts: [port],
      agentFor: permissiveAgent,
    })
    expect(result).toBeUndefined()
  })
})
