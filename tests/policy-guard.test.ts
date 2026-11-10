import { describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../src/logger"
import type { SessionManager } from "../src/session/manager"
import type { ToolPolicy } from "../src/tools/policy"
import { registerToolPolicy } from "../src/tools/policy-guard"

interface BeforeEvent {
  tool: string
  sessionID: string
}

interface Harness {
  before(tool: string): Promise<void>
  setBound(bound: boolean): void
}

async function createHarness(options: { allow?: string[]; role?: "member" | "admin" } = {}) {
  let bound = true
  const manager = {
    targetForSession: vi.fn(() => (bound ? { kind: "group", id: 100 } : undefined)),
    currentRole: vi.fn(() => options.role ?? "member"),
  }
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const policy = {
    allow: vi.fn(
      async (_role: string, _key: string, names: string[]) =>
        new Set(names.filter((name) => (options.allow ?? []).includes(name))),
    ),
    profileOf: vi.fn(async () => "test"),
  }
  let handler: ((event: BeforeEvent) => Promise<void>) | undefined
  const ctx = {
    tool: {
      hook: vi.fn(async (_name: string, callback: (event: BeforeEvent) => Promise<void>) => {
        handler = callback
        return { dispose: vi.fn(async () => {}) }
      }),
    },
  } as unknown as Plugin.Context

  await registerToolPolicy({
    ctx,
    logger: logger as unknown as Logger,
    manager: manager as unknown as SessionManager,
    policy: policy as unknown as ToolPolicy,
  })

  const harness: Harness = {
    async before(tool) {
      await handler?.({ tool, sessionID: "ses_1" })
    },
    setBound(next) {
      bound = next
    },
  }
  return { harness, logger, policy }
}

describe("registerToolPolicy", () => {
  it("QQ 会话里拒绝创建子代理", async () => {
    const { harness, logger } = await createHarness({ allow: ["subagent", "task"] })
    await expect(harness.before("subagent")).rejects.toThrow(/子代理/)
    await expect(harness.before("task")).rejects.toThrow(/子代理/)
    expect(logger.warn).toHaveBeenCalled()
  })

  it("会话没有绑定 QQ 目标时放行", async () => {
    const { harness } = await createHarness({ allow: ["subagent"] })
    harness.setBound(false)
    await expect(harness.before("subagent")).resolves.toBeUndefined()
  })

  it("没有在途轮次时仍按会话角色收窄", async () => {
    const { harness, policy } = await createHarness({ allow: ["websearch"], role: "member" })
    await expect(harness.before("shell")).rejects.toThrow(/tool-profiles/)
    expect(policy.allow).toHaveBeenCalledWith("member", "group:100", ["shell"])
  })

  it("按配置档拒绝其它工具", async () => {
    const { harness } = await createHarness({ allow: ["websearch"] })
    await expect(harness.before("websearch")).resolves.toBeUndefined()
    await expect(harness.before("shell")).rejects.toThrow(/tool-profiles/)
  })

  it("申请回复权限的工具始终放行", async () => {
    const { harness } = await createHarness({ allow: ["websearch"] })
    await expect(harness.before("qq_request_reply")).resolves.toBeUndefined()
  })
})
