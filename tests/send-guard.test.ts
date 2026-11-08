import { describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../src/logger"
import type { SessionManager, Turn } from "../src/session/manager"
import { DUPLICATE_SEND_REFUSAL, registerSendGuard } from "../src/tools/send-guard"

interface BeforeEvent {
  tool: string
  sessionID: string
  id: string
}

interface AfterEvent extends BeforeEvent {
  status: "completed" | "error"
  result?: { content?: string; metadata?: Record<string, unknown> }
}

const newTurn = (): Turn => ({ text: "hi", files: [], atMe: false })

interface Harness {
  hooks: Map<string, (event: BeforeEvent & AfterEvent) => Promise<void>>
  registration: { dispose(): Promise<void> }
  disposers: ReturnType<typeof vi.fn>[]
  manager: {
    hasActiveTurn: ReturnType<typeof vi.fn>
    currentTurn: ReturnType<typeof vi.fn>
  }
  logger: Record<keyof Logger, ReturnType<typeof vi.fn>>
  setActive(active: boolean): void
  setTurn(turn: Turn | undefined): void
  before(tool: string, id?: string): Promise<void>
  after(
    tool: string,
    id: string,
    status?: "completed" | "error",
    result?: AfterEvent["result"],
  ): Promise<void>
}

async function createHarness(): Promise<Harness> {
  let active = true
  let turn: Turn | undefined = newTurn()
  const manager = {
    hasActiveTurn: vi.fn(() => active),
    currentTurn: vi.fn(() => turn),
  }
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const disposers: ReturnType<typeof vi.fn>[] = []
  const hooks = new Map<string, (event: BeforeEvent & AfterEvent) => Promise<void>>()
  const ctx = {
    tool: {
      hook: vi.fn(async (name: string, cb: (event: BeforeEvent & AfterEvent) => Promise<void>) => {
        const dispose = vi.fn(async () => {})
        disposers.push(dispose)
        hooks.set(name, cb)
        return { dispose }
      }),
    },
  } as unknown as Plugin.Context

  const registration = await registerSendGuard({
    ctx,
    logger,
    manager: manager as unknown as SessionManager,
  })

  return {
    hooks,
    registration,
    disposers,
    manager,
    logger,
    setActive(next) {
      active = next
    },
    setTurn(next) {
      turn = next
    },
    async before(tool, id = `${tool}-${Math.random()}`) {
      await hooks.get("execute.before")?.({ tool, sessionID: "ses_1", id, status: "completed" })
    },
    async after(tool, id, status = "completed", result) {
      await hooks.get("execute.after")?.({
        tool,
        sessionID: "ses_1",
        id,
        status,
        ...(result ? { result } : {}),
      })
    },
  }
}

describe("registerSendGuard", () => {
  it("注册 execute.before 与 execute.after 钩子", async () => {
    const harness = await createHarness()
    expect([...harness.hooks.keys()].sort()).toEqual(["execute.after", "execute.before"])
  })

  it("非发送工具之后可以发送", async () => {
    const harness = await createHarness()
    await harness.before("read")
    await expect(harness.before("qq_send_message", "c1")).resolves.toBeUndefined()
  })

  it("连续调用发送工具会被拒绝", async () => {
    const harness = await createHarness()
    await harness.before("qq_send_message", "c1")
    await expect(harness.before("qq_send_message", "c2")).rejects.toThrow(DUPLICATE_SEND_REFUSAL)
    expect(harness.logger.warn).toHaveBeenCalled()
  })

  it("中间调用其它工具后可以再次发送", async () => {
    const harness = await createHarness()
    await harness.before("qq_send_message", "c1")
    await harness.before("qq_favorite_list")
    await expect(harness.before("qq_send_message", "c2")).resolves.toBeUndefined()
  })

  it("跨轮次不视为连续调用", async () => {
    const harness = await createHarness()
    await harness.before("qq_send_message", "c1")
    harness.setTurn(newTurn())
    await expect(harness.before("qq_send_message", "c2")).resolves.toBeUndefined()
  })

  it("发送失败后允许立即重试", async () => {
    const harness = await createHarness()
    await harness.before("qq_send_message", "c1")
    await harness.after("qq_send_message", "c1", "error")
    await expect(harness.before("qq_send_message", "c2")).resolves.toBeUndefined()
  })

  it("返回 error 文本的发送失败也允许立即重试", async () => {
    const harness = await createHarness()
    await harness.before("qq_send_message", "c1")
    await harness.after("qq_send_message", "c1", "completed", {
      content: "error: 消息只发送了 0/1 段",
      metadata: { failed: true },
    })
    await expect(harness.before("qq_send_message", "c2")).resolves.toBeUndefined()
  })

  it("限流拒绝不撤销发送标记", async () => {
    const harness = await createHarness()
    await harness.before("qq_send_message", "c1")
    await harness.after("qq_send_message", "c1", "completed", {
      content: "error: 发送频率超限",
      metadata: { failed: true, retryable: false },
    })
    await expect(harness.before("qq_send_message", "c2")).rejects.toThrow(DUPLICATE_SEND_REFUSAL)
  })

  it("被拒绝的调用不会撤销上一条发送标记", async () => {
    const harness = await createHarness()
    await harness.before("qq_send_message", "c1")
    await expect(harness.before("qq_send_message", "c2")).rejects.toThrow()
    await harness.after("qq_send_message", "c2", "error")
    await expect(harness.before("qq_send_message", "c3")).rejects.toThrow(DUPLICATE_SEND_REFUSAL)
  })

  it("人工在 TUI 驱动时不限制连续发送", async () => {
    const harness = await createHarness()
    harness.setActive(false)
    await harness.before("qq_send_message", "c1")
    await expect(harness.before("qq_send_message", "c2")).resolves.toBeUndefined()
    expect(harness.logger.warn).not.toHaveBeenCalled()
  })

  it("兼容不带命名空间的发送工具名", async () => {
    const harness = await createHarness()
    await harness.before("send_message", "c1")
    await expect(harness.before("send_image", "c2")).rejects.toThrow(DUPLICATE_SEND_REFUSAL)
  })

  it("dispose 会释放两个钩子", async () => {
    const harness = await createHarness()
    await harness.registration.dispose()
    expect(harness.disposers).toHaveLength(2)
    for (const dispose of harness.disposers) expect(dispose).toHaveBeenCalled()
  })
})
