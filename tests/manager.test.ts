import { describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin"
import { MAX_BUFFER_TURNS, SessionManager, mergeTurns } from "../src/session/manager"
import { DEFAULT_CONFIG, type QQBotConfig } from "../src/config"
import { MAX_PROMPT_IMAGES } from "../src/naplink/render"
import type { Logger } from "../src/logger"

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

interface Harness {
  manager: SessionManager
  prompts: Array<{ sessionID: string; text: string }>
  synthetics: Array<{ sessionID: string; text: string }>
  storage: {
    get: ReturnType<typeof vi.fn>
    set: ReturnType<typeof vi.fn>
  }
  sessionGet: ReturnType<typeof vi.fn>
}

function createHarness(
  overrides: Partial<QQBotConfig> = {},
  createId?: () => string,
  stored?: Record<string, string>,
): Harness {
  const prompts: Harness["prompts"] = []
  const synthetics: Harness["synthetics"] = []
  let created = 0

  const storage: Harness["storage"] = {
    get: vi.fn(async () => stored),
    set: vi.fn(async () => {}),
  }
  const sessionGet = vi.fn(async (input: { sessionID: string }) => ({ id: input.sessionID }))

  const ctx = {
    location: { directory: "/tmp" },
    storage,
    session: {
      create: vi.fn(async () => {
        if (createId) return { id: createId() }
        created += 1
        return { id: `session-${created}` }
      }),
      get: sessionGet,
      remove: vi.fn(async () => {}),
      prompt: vi.fn(async (input: { sessionID: string; text: string }) => {
        prompts.push(input)
      }),
      synthetic: vi.fn(async (input: { sessionID: string; text: string }) => {
        synthetics.push(input)
      }),
      list: vi.fn(async () => ({ data: [], cursor: {} })),
    },
  } as unknown as Plugin.Context

  const config: QQBotConfig = {
    ...DEFAULT_CONFIG,
    napcat: { url: "ws://127.0.0.1:3001" },
    groups: [100],
    ...overrides,
  }

  return {
    manager: new SessionManager(ctx, config, logger),
    prompts,
    synthetics,
    storage,
    sessionGet,
  }
}

describe("mergeTurns", () => {
  it("joins texts, collects files and keeps the at flag", () => {
    const merged = mergeTurns([
      { text: "第一条", files: [{ uri: "data:image/png;base64,AA", name: "a.png" }], atMe: false },
      { text: "第二条", files: [{ uri: "data:image/png;base64,BB", name: "b.png" }], atMe: true },
    ])
    expect(merged.text).toBe("第一条\n第二条")
    expect(merged.files).toHaveLength(2)
    expect(merged.atMe).toBe(true)
  })

  it("drops empty turns", () => {
    const merged = mergeTurns([{ text: "  ", files: [], atMe: false }])
    expect(merged.text).toBe("")
  })

  it("caps the number of merged image files", () => {
    const files = Array.from({ length: MAX_PROMPT_IMAGES + 3 }, (_, index) => ({
      uri: `data:image/png;base64,${"A".repeat(16)}`,
      name: `image-${index}.png`,
    }))
    const merged = mergeTurns([{ text: "看图", files, atMe: false }])
    expect(merged.files).toHaveLength(MAX_PROMPT_IMAGES)
  })
})

describe("SessionManager", () => {
  it("creates a session and dispatches the first message", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(100, { text: "你好", files: [], atMe: false })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.text).toBe("你好")
    expect(manager.groupForSession("session-1")).toBe(100)
  })

  it("restores the session binding from storage", async () => {
    const { manager, prompts } = createHarness({}, undefined, { "100": "session-restored" })
    await manager.load()
    await manager.enqueue(100, { text: "你好", files: [], atMe: false })
    expect(prompts[0]?.sessionID).toBe("session-restored")
    expect(manager.groupForSession("session-restored")).toBe(100)
  })

  it("persists a new session binding", async () => {
    const { manager, storage } = createHarness()
    await manager.enqueue(100, { text: "你好", files: [], atMe: false })
    await vi.waitFor(() => {
      expect(storage.set).toHaveBeenCalledWith("bindings", { "100": "session-1" })
    })
  })

  it("ignores malformed stored bindings", async () => {
    const stored = { oops: "session-x", "100": 42 } as unknown as Record<string, string>
    const { manager, prompts } = createHarness({}, undefined, stored)
    await manager.load()
    await manager.enqueue(100, { text: "你好", files: [], atMe: false })
    expect(prompts[0]?.sessionID).toBe("session-1")
  })

  it("buffers messages while the session is busy and flushes them on idle", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(100, { text: "第一条", files: [], atMe: false })
    await manager.enqueue(100, { text: "第二条", files: [], atMe: false })
    expect(prompts).toHaveLength(1)

    // idle 钩子里不投递，等真正空闲后再合并成新一轮。
    await manager.handleIdle("session-1")
    expect(prompts).toHaveLength(1)

    await manager.flushBuffered("session-1")
    expect(prompts).toHaveLength(2)
    expect(prompts[1]?.text).toBe("第二条")
  })

  it("merges several buffered messages into one prompt", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(100, { text: "第一条", files: [], atMe: false })
    await manager.enqueue(100, { text: "第二条", files: [], atMe: false })
    await manager.enqueue(100, { text: "第三条", files: [], atMe: false })

    await manager.handleIdle("session-1")
    await manager.flushBuffered("session-1")
    expect(prompts).toHaveLength(2)
    expect(prompts[1]?.text).toBe("第二条\n第三条")
  })

  it("refuses to bind one session to two groups", async () => {
    const { manager, prompts } = createHarness({}, () => "session-1")
    await manager.enqueue(100, { text: "第一条", files: [], atMe: false })
    expect(prompts).toHaveLength(1)

    // 复用同一个会话 ID 时必须拒绝，否则两个群会共用一条会话。
    await manager.enqueue(200, { text: "第二条", files: [], atMe: false })
    expect(prompts).toHaveLength(1)
    expect(manager.groupForSession("session-1")).toBe(100)
  })

  it("reminds the model when it never called the send tool", async () => {
    const { manager, synthetics } = createHarness()
    await manager.enqueue(100, { text: "你好", files: [], atMe: false })
    await manager.handleIdle("session-1")
    expect(synthetics).toHaveLength(1)
    expect(synthetics[0]?.text).toContain("qq_send_message")
  })

  it("stops reminding once the send tool was called", async () => {
    const { manager, synthetics } = createHarness()
    await manager.enqueue(100, { text: "你好", files: [], atMe: false })
    manager.markMessageSent("session-1")
    await manager.handleIdle("session-1")
    expect(synthetics).toHaveLength(0)
  })

  it("caps the number of reminders", async () => {
    const { manager, synthetics } = createHarness({ reminder: { enabled: true, max: 1 } })
    await manager.enqueue(100, { text: "你好", files: [], atMe: false })
    await manager.handleIdle("session-1")
    await manager.handleIdle("session-1")
    expect(synthetics).toHaveLength(1)
  })

  it("ignores idle events of unrelated sessions", async () => {
    const { manager, synthetics } = createHarness()
    await manager.handleIdle("unknown")
    expect(synthetics).toHaveLength(0)
  })

  it("reuses an existing session when reuseSession is enabled", async () => {
    const { manager, prompts } = createHarness({ reuseSession: true })
    await manager.enqueue(100, { text: "你好", files: [], atMe: false })
    expect(prompts).toHaveLength(1)
  })

  it("skips the reminder while background work is still running", async () => {
    const { manager, synthetics } = createHarness()
    await manager.enqueue(100, { text: "你好", files: [], atMe: false })
    await manager.handleIdle("session-1", [{ sessionID: "session-1" }])
    expect(synthetics).toHaveLength(0)
  })

  it("keeps the session busy while its own background work is still running", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(100, { text: "第一条", files: [], atMe: false })
    await manager.handleIdle("session-1", [{ sessionID: "session-1" }])

    // 后台任务还在跑，新消息必须排队，不能插进正在执行的会话。
    await manager.enqueue(100, { text: "第二条", files: [], atMe: false })
    expect(prompts).toHaveLength(1)

    await manager.handleIdle("session-1")
    expect(prompts).toHaveLength(1)

    await manager.flushBuffered("session-1")
    expect(prompts).toHaveLength(2)
    expect(prompts[1]?.text).toBe("第二条")
  })

  it("ignores background work owned by descendant sessions", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(100, { text: "第一条", files: [], atMe: false })
    manager.markMessageSent("session-1")
    await manager.handleIdle("session-1", [{ sessionID: "child-session" }])

    await manager.enqueue(100, { text: "第二条", files: [], atMe: false })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]?.text).toBe("第二条")
  })

  it("releases stale busy state on an idle event without buffered messages", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(100, { text: "第一条", files: [], atMe: false })
    // 模拟控制类工作只发 session.idle、不触发 idle 钩子。
    await manager.flushBuffered("session-1")
    await manager.enqueue(100, { text: "第二条", files: [], atMe: false })
    expect(prompts).toHaveLength(2)
  })

  it("does not flush the same buffered messages twice", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(100, { text: "第一条", files: [], atMe: false })
    await manager.enqueue(100, { text: "第二条", files: [], atMe: false })

    await manager.flushBuffered("session-1")
    await manager.flushBuffered("session-1")
    expect(prompts).toHaveLength(2)
  })

  it("gives every user turn a fresh reminder budget", async () => {
    const { manager, synthetics } = createHarness({ reminder: { enabled: true, max: 1 } })
    await manager.enqueue(100, { text: "第一条", files: [], atMe: false })
    await manager.handleIdle("session-1")
    await manager.handleIdle("session-1")
    expect(synthetics).toHaveLength(1)

    // 新的用户轮次重新获得提醒预算。
    await manager.enqueue(100, { text: "第二条", files: [], atMe: false })
    await manager.handleIdle("session-1")
    expect(synthetics).toHaveLength(2)
  })

  it("releases buffered messages when the session stays busy past the timeout", async () => {
    vi.useFakeTimers()
    try {
      const { manager, prompts } = createHarness({ busyTimeoutMs: 1000 })
      await manager.enqueue(100, { text: "第一条", files: [], atMe: false })
      await manager.enqueue(100, { text: "第二条", files: [], atMe: false })
      expect(prompts).toHaveLength(1)

      // 即使群里没有新消息，看门狗也会在超时后放行缓存。
      await vi.advanceTimersByTimeAsync(1500)
      expect(prompts).toHaveLength(2)
      expect(prompts[1]?.text).toBe("第二条")
    } finally {
      vi.useRealTimers()
    }
  })

  it("releases the busy state when the model execution fails", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(100, { text: "第一条", files: [], atMe: false })
    await manager.enqueue(100, { text: "第二条", files: [], atMe: false })
    expect(prompts).toHaveLength(1)

    await manager.handleExecutionEnd("session-1", "session.execution.failed")
    expect(prompts).toHaveLength(2)
    expect(prompts[1]?.text).toBe("第二条")
  })

  it("creates only one session for concurrent ensureSession calls", async () => {
    const { manager } = createHarness()
    const [first, second] = await Promise.all([
      manager.ensureSession(100),
      manager.ensureSession(100),
    ])
    expect(first).toBe("session-1")
    expect(second).toBe("session-1")
  })

  it("rebuilds a binding when the restored session no longer exists", async () => {
    const { manager, prompts, sessionGet } = createHarness({}, undefined, { "100": "gone" })
    sessionGet.mockRejectedValueOnce(new Error("not found"))
    await manager.load()
    await manager.enqueue(100, { text: "你好", files: [], atMe: false })
    expect(prompts[0]?.sessionID).toBe("session-1")
    expect(manager.groupForSession("gone")).toBeUndefined()
  })

  it("does not create a proactive turn while the group is busy", async () => {
    const { manager, synthetics } = createHarness()
    await manager.enqueue(100, { text: "你好", files: [], atMe: false })
    await manager.proactive(100, "主动话题")
    expect(synthetics).toHaveLength(0)
  })

  it("drops the oldest buffered messages when the buffer is full", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(100, { text: "first", files: [], atMe: false })
    for (let index = 0; index < MAX_BUFFER_TURNS + 5; index += 1) {
      await manager.enqueue(100, { text: `buffered-${index}`, files: [], atMe: false })
    }
    await manager.handleIdle("session-1")
    await manager.flushBuffered("session-1")
    const merged = prompts[1]?.text ?? ""
    expect(merged).not.toContain("buffered-0")
    expect(merged).toContain(`buffered-${MAX_BUFFER_TURNS + 4}`)
  })

  it("flushes bindings and activity to storage", async () => {
    const { manager, storage } = createHarness()
    manager.touch(100)
    await manager.enqueue(100, { text: "你好", files: [], atMe: false })
    await manager.flush()
    expect(storage.set).toHaveBeenCalledWith("bindings", { "100": "session-1" })
    expect(storage.set).toHaveBeenCalledWith(
      "activity",
      expect.objectContaining({ "100": expect.any(Number) }),
    )
  })
})
