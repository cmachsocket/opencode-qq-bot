import { describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin"
import { ASK_REFUSAL, QUESTION_TOOL, registerAskGuard } from "../src/tools/ask-guard"
import type { ChatTarget } from "../src/chat"
import type { Logger } from "../src/logger"
import type { SessionManager } from "../src/session/manager"

interface HookEvent {
  tool: string
  sessionID: string
}

interface Harness {
  hookName: string
  callback: (event: HookEvent) => Promise<void>
  registration: { dispose(): Promise<void> }
  release: ReturnType<typeof vi.fn>
  manager: { targetForSession: ReturnType<typeof vi.fn> }
  logger: Record<keyof Logger, ReturnType<typeof vi.fn>>
}

const group = (id: number): ChatTarget => ({ kind: "group", id })

async function createHarness(target: ChatTarget | undefined): Promise<Harness> {
  const manager = {
    targetForSession: vi.fn(() => target),
  }
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const release = vi.fn(async () => {})
  let hookName = ""
  let callback: (event: HookEvent) => Promise<void> = async () => {}
  const ctx = {
    tool: {
      hook: vi.fn(async (name: string, cb: (event: HookEvent) => Promise<void>) => {
        hookName = name
        callback = cb
        return { dispose: release }
      }),
    },
  } as unknown as Plugin.Context

  const registration = await registerAskGuard({
    ctx,
    logger,
    manager: manager as unknown as SessionManager,
  })

  return { hookName, callback, registration, release, manager, logger }
}

describe("registerAskGuard", () => {
  it("注册 execute.before 钩子", async () => {
    const harness = await createHarness(group(100))
    expect(harness.hookName).toBe("execute.before")
  })

  it("QQ 会话里拒绝 question 工具", async () => {
    const harness = await createHarness(group(100))
    await expect(harness.callback({ tool: QUESTION_TOOL, sessionID: "ses_1" })).rejects.toThrow(
      ASK_REFUSAL,
    )
    expect(harness.manager.targetForSession).toHaveBeenCalledWith("ses_1")
    expect(harness.logger.warn).toHaveBeenCalled()
  })

  it("非 QQ 会话不拦截 question 工具", async () => {
    const harness = await createHarness(undefined)
    await expect(
      harness.callback({ tool: QUESTION_TOOL, sessionID: "ses_2" }),
    ).resolves.toBeUndefined()
    expect(harness.logger.warn).not.toHaveBeenCalled()
  })

  it("QQ 会话里其他工具照常执行", async () => {
    const harness = await createHarness(group(100))
    await expect(harness.callback({ tool: "read", sessionID: "ses_3" })).resolves.toBeUndefined()
    expect(harness.logger.warn).not.toHaveBeenCalled()
  })

  it("dispose 会释放注册", async () => {
    const harness = await createHarness(group(100))
    await harness.registration.dispose()
    expect(harness.release).toHaveBeenCalled()
  })
})
