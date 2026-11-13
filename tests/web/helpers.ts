import { vi } from "vitest"

/** 一次被记录下来的请求。 */
export interface RecordedRequest {
  /** 请求路径。 */
  url: string
  /** 请求方法。 */
  method: string
  /** 请求体（JSON 解析后的结果）。 */
  body: unknown
}

/** 假响应的形状。 */
export interface FakeResponse {
  /** HTTP 状态码，默认 200。 */
  status?: number
  /** 响应体。 */
  body: unknown
}

/**
 * 顶掉 `fetch`：按请求给出响应，并把请求记录下来。
 *
 * 前端的数据层只用原生 `fetch`，所以替掉它就能测到真实的一整轮请求。
 */
export function stubFetch(handler: (request: RecordedRequest) => FakeResponse): RecordedRequest[] {
  const requests: RecordedRequest[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    requests.push(request)
    const { status = 200, body } = handler(request)
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  })
  return requests
}
