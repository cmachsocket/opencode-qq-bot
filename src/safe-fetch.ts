import http from "node:http"
import https from "node:https"
import { useAgent } from "request-filtering-agent"
import type { Logger } from "./logger"

/** 允许的出站端口：只放行常见的网页端口，其余一律拒绝。 */
export const ALLOWED_PORTS: readonly number[] = [80, 443, 8080, 8443]

/** 出站请求用的 User-Agent。 */
const USER_AGENT = "opencode-qq-bot"

export interface SafeFetchOptions {
  /** 响应体字节上限，超出即中断下载。 */
  maxBytes: number
  /** 单次请求超时（毫秒）。 */
  timeoutMs: number
  logger: Logger
  /** 允许的端口，默认 {@link ALLOWED_PORTS}。 */
  allowedPorts?: readonly number[]
  /** 生成连接用的 agent，默认用 request-filtering-agent；测试可注入。 */
  agentFor?: (href: string) => http.Agent | https.Agent
}

export interface SafeFetchResult {
  /** HTTP 状态码。 */
  status: number
  /** content-type 响应头。 */
  contentType?: string
  /** 响应体。 */
  bytes: Uint8Array
}

/** 下载远端文件的函数签名；实现可替换，便于测试。 */
export type SafeFetcher = (
  url: URL,
  options: SafeFetchOptions,
) => Promise<SafeFetchResult | undefined>

/** 截断过长的地址，避免日志被超长 URL 淹没。 */
function truncateForLog(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * 下载一个远端文件，挡住指向内网的请求。
 *
 * 只做字符串判断挡不住 DNS 重绑定：域名解析出来的地址随时可以变。
 * 这里把判定放到连接层——先解析 DNS，解析出的每一个地址都要过一遍公网判定
 * （回环、私网、CGNAT、IPv4-mapped、NAT64、6to4 之类一律不算公网地址），
 * 判定通过才连过去；连的是刚判定过的那个地址，Host 与 SNI 保持原样。
 *
 * 另外只放行白名单里的端口，也不跟随跳转：3xx 直接算失败，
 * 免得用跳转绕过判定。
 */
export async function safeFetchBytes(
  url: URL,
  options: SafeFetchOptions,
): Promise<SafeFetchResult | undefined> {
  const { logger } = options
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    logger.warn(`拒绝下载不支持的协议 protocol=${url.protocol}`)
    return undefined
  }
  const allowedPorts = options.allowedPorts ?? ALLOWED_PORTS
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
  if (!allowedPorts.includes(port)) {
    logger.warn(`拒绝下载非白名单端口 port=${port} url=${truncateForLog(url.href)}`)
    return undefined
  }

  const agent = options.agentFor?.(url.href) ?? useAgent(url.href)
  const requester = url.protocol === "https:" ? https : http

  return await new Promise<SafeFetchResult | undefined>((resolve) => {
    let settled = false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs)
    const finish = (result?: SafeFetchResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const request = requester.request(url, {
      agent: agent as http.Agent,
      headers: { "user-agent": USER_AGENT },
      signal: controller.signal,
    })

    request.on("response", (response) => {
      const status = response.statusCode ?? 0
      if (status < 200 || status >= 300) {
        response.resume()
        logger.warn(`下载失败 status=${status} url=${truncateForLog(url.href)}`)
        finish()
        return
      }
      const declared = Number(response.headers["content-length"])
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        response.destroy()
        logger.warn(`文件过大，跳过下载 bytes=${declared} url=${truncateForLog(url.href)}`)
        finish()
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      response.on("data", (chunk: Buffer) => {
        total += chunk.length
        if (total > options.maxBytes) {
          request.destroy()
          logger.warn(`文件过大，跳过下载 url=${truncateForLog(url.href)}`)
          finish()
          return
        }
        chunks.push(chunk)
      })
      response.on("end", () => {
        const contentType = response.headers["content-type"]
        finish({
          status,
          contentType: typeof contentType === "string" ? contentType : undefined,
          bytes: new Uint8Array(Buffer.concat(chunks)),
        })
      })
      response.on("error", (error) => {
        if (settled) return
        logger.warn(`下载中断 url=${truncateForLog(url.href)}`, error)
        finish()
      })
    })
    request.on("error", (error) => {
      if (settled) return
      if (controller.signal.aborted) {
        logger.warn(`下载超时 url=${truncateForLog(url.href)}`)
      } else {
        logger.warn(`下载异常 url=${truncateForLog(url.href)}`, error)
      }
      finish()
    })
    request.end()
  })
}
