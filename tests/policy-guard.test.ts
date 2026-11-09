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
  setActive(active: boolean): void
}

async function createHarness(options: { allow?: string[]; role?: "member" | "admin" } = {}) {
  let active = true
  const manager = {
    activeTurn: vi.fn(() =>
      active
        ? { target: { kind: "group", id: 100 }, turn: undefined, role: options.role }
        : undefined,
    ),
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
    setActive(next) {
      active = next
    },
  }
  return { harness, logger, policy }
}

describe("registerToolPolicy", () => {
  it("QQ 轮次里拒绝创建子代理", async () => {
    const { harness, logger } = await createHarness({ allow: ["subagent", "task"] })
    await expect(harness.before("subagent")).rejects.toThrow(/子代理/)
    await expect(harness.before("task")).rejects.toThrow(/子代理/)
    expect(logger.warn).toHaveBeenCalled()
  })

  it("没有 QQ 轮次时放行子代理", async () => {
    const { harness } = await createHarness({ allow: ["subagent"] })
    harness.setActive(false)
    await expect(harness.before("subagent")).resolves.toBeUndefined()
  })

  it("按配置档拒绝其它工具", async () => {
    const { harness } = await createHarness({ allow: ["websearch"] })
    await expect(harness.before("websearch")).resolves.toBeUndefined()
    await expect(harness.before("shell")).rejects.toThrow(/tool-profiles/)
  })
})
