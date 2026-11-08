import { describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin"
import {
  FAILURE_NOTICE,
  FAILURE_NOTICE_INTERVAL_MS,
  INTERRUPTED_NOTICE,
  MAX_BUFFER_TURNS,
  PENDING_MAX_ATTEMPTS,
  RESUME_INTERVAL_MS,
  SUBMIT_GRACE_MS,
  SessionManager,
  mergeTurns,
} from "../src/session/manager"
import { DEFAULT_CONFIG, type QQBotConfig } from "../src/config"
import type { ChatTarget } from "../src/chat"
import type { HistoryOptions, HistoryPosition, HistoryProvider } from "../src/naplink/history"
import { MAX_PROMPT_IMAGES } from "../src/naplink/render"
import type { Logger } from "../src/logger"

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const group = (id: number): ChatTarget => ({ kind: "group", id })
const privateChat = (id: number): ChatTarget => ({ kind: "private", id })

interface Harness {
  manager: SessionManager
  prompts: Array<{ sessionID: string; text: string; id?: string; files?: unknown }>
  prompt: ReturnType<typeof vi.fn>
  synthetics: Array<{ sessionID: string; text: string }>
  storage: {
    get: ReturnType<typeof vi.fn>
    set: ReturnType<typeof vi.fn>
  }
  sessionGet: ReturnType<typeof vi.fn>
  sessionCreate: ReturnType<typeof vi.fn>
  sessionRemove: ReturnType<typeof vi.fn>
  sessionInterrupt: ReturnType<typeof vi.fn>
  notices: Array<{ target: ChatTarget; text: string }>
}

function createHarness(
  overrides: Partial<QQBotConfig> = {},
  createId?: () => string,
  stored?: Record<string, string>,
  history?: HistoryProvider,
  positions?: Record<string, HistoryPosition>,
): Harness {
  const prompts: Harness["prompts"] = []
  const synthetics: Harness["synthetics"] = []
  let created = 0

  const storage: Harness["storage"] = {
    get: vi.fn(async (key: string) => {
      if (key === "positions") return positions
      if (key === "activity") return undefined
      return stored
    }),
    set: vi.fn(async () => {}),
  }
  const sessionGet = vi.fn(
    async (input: { sessionID: string }): Promise<Record<string, unknown>> => ({
      id: input.sessionID,
    }),
  )
  const sessionCreate = vi.fn(async () => {
    if (createId) return { id: createId() }
    created += 1
    return { id: `session-${created}` }
  })
  const prompt = vi.fn(
    async (input: { sessionID: string; text: string; id?: string; files?: unknown }) => {
      prompts.push(input)
    },
  )
  const notices: Array<{ target: ChatTarget; text: string }> = []

  const ctx = {
    location: { directory: "/tmp" },
    storage,
    session: {
      create: sessionCreate,
      get: sessionGet,
      remove: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      prompt,
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
    manager: new SessionManager(
      ctx,
      config,
      logger,
      { directory: "/tmp" },
      history,
      async (target, text) => {
        notices.push({ target, text })
      },
    ),
    notices,
    prompts,
    prompt,
    synthetics,
    storage,
    sessionGet,
    sessionCreate,
    sessionRemove: (ctx.session as unknown as { remove: ReturnType<typeof vi.fn> }).remove,
    sessionInterrupt: (ctx.session as unknown as { interrupt: ReturnType<typeof vi.fn> }).interrupt,
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
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.text).toBe("你好")
    // 上游要求消息 ID 以 msg_ 开头，否则 session.prompt 会直接报 SchemaError。
    expect(prompts[0]?.id).toMatch(/^msg_/)
    expect(manager.targetForSession("session-1")).toEqual(group(100))
  })

  it("creates a private session with its own title and metadata", async () => {
    const { manager, prompts, sessionCreate } = createHarness({ users: [200] })
    await manager.enqueue(privateChat(200), { text: "你好", files: [], atMe: false })
    expect(prompts).toHaveLength(1)
    expect(manager.targetForSession("session-1")).toEqual(privateChat(200))
    expect(sessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "QQ 私聊 200",
        location: { directory: "/tmp" },
        metadata: { qqTargetKind: "private", qqTargetId: 200 },
      }),
    )
  })

  it("keeps a group and a private chat with the same id apart", async () => {
    const { manager, prompts } = createHarness({ groups: [200], users: [200] })
    await manager.enqueue(group(200), { text: "群消息", files: [], atMe: false })
    await manager.enqueue(privateChat(200), { text: "私聊消息", files: [], atMe: false })
    expect(prompts).toHaveLength(2)
    expect(manager.targetForSession("session-1")).toEqual(group(200))
    expect(manager.targetForSession("session-2")).toEqual(privateChat(200))
  })

  it("restores the session binding from storage", async () => {
    const { manager, prompts } = createHarness({}, undefined, { "group:100": "session-restored" })
    await manager.load()
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    expect(prompts[0]?.sessionID).toBe("session-restored")
    expect(manager.targetForSession("session-restored")).toEqual(group(100))
  })

  it("ignores legacy numeric bindings", async () => {
    const { manager, prompts } = createHarness({}, undefined, { "100": "session-old" })
    await manager.load()
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    expect(prompts[0]?.sessionID).toBe("session-1")
  })

  it("persists a new session binding", async () => {
    const { manager, storage } = createHarness()
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    await vi.waitFor(() => {
      expect(storage.set).toHaveBeenCalledWith("bindings", { "group:100": "session-1" })
    })
  })

  it("ignores malformed stored bindings", async () => {
    const stored = { oops: "session-x", "group:100": 42 } as unknown as Record<string, string>
    const { manager, prompts } = createHarness({}, undefined, stored)
    await manager.load()
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    expect(prompts[0]?.sessionID).toBe("session-1")
  })

  it("buffers messages while upstream is still running and flushes them on idle", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
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
    await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
    await manager.enqueue(group(100), { text: "第三条", files: [], atMe: false })

    await manager.handleIdle("session-1")
    await manager.flushBuffered("session-1")
    expect(prompts).toHaveLength(2)
    expect(prompts[1]?.text).toBe("第二条\n第三条")
  })

  it("ignores a late idle hook from the previous run", async () => {
    vi.useFakeTimers()
    try {
      const { manager, prompts, synthetics, sessionGet } = createHarness()
      vi.setSystemTime(new Date(10_000))
      await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
      expect(prompts).toHaveLength(1)

      vi.setSystemTime(new Date(11_000))
      await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
      expect(prompts).toHaveLength(1)

      // 上一轮在 10.5s 结束，但结束信号直到新一轮投递后才到。
      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(9_000), idle: new Date(10_500) },
      })
      await manager.flushBuffered("session-1")
      expect(prompts).toHaveLength(2)

      vi.setSystemTime(new Date(12_000))
      await manager.handleIdle("session-1")
      expect(synthetics).toHaveLength(0)
      expect(manager.currentTurn("session-1")?.text).toBe("第二条")

      // 上游还没记录新一轮的 busy，第三条不能被提前投递。
      await manager.enqueue(group(100), { text: "第三条", files: [], atMe: false })
      expect(prompts).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps the new turn when a duplicate end event arrives", async () => {
    vi.useFakeTimers()
    try {
      const { manager, prompts, sessionGet } = createHarness()
      vi.setSystemTime(new Date(10_000))
      await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })

      vi.setSystemTime(new Date(11_000))
      await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
      expect(prompts).toHaveLength(1)

      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(9_000), idle: new Date(10_500) },
      })
      await manager.flushBuffered("session-1")
      expect(prompts).toHaveLength(2)

      // 同一次执行又发来一个结束信号，不能清掉刚投递的轮次。
      vi.setSystemTime(new Date(11_500))
      await manager.flushBuffered("session-1")
      expect(manager.currentTurn("session-1")?.text).toBe("第二条")
    } finally {
      vi.useRealTimers()
    }
  })

  it("retries an ambiguous prompt with the same idempotency key", async () => {
    vi.useFakeTimers()
    try {
      const { manager, prompt, sessionGet } = createHarness()
      vi.setSystemTime(new Date(10_000))
      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(9_000), idle: undefined },
      })
      prompt.mockRejectedValueOnce(new Error("timeout"))
      await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
      expect(prompt).toHaveBeenCalledTimes(1)

      vi.setSystemTime(new Date(10_000 + SUBMIT_GRACE_MS + 1))
      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(10_000 + 5_000), idle: new Date(10_000 + 5_000) },
      })
      await manager.resumeBuffered()
      expect(prompt).toHaveBeenCalledTimes(2)

      const first = prompt.mock.calls[0]?.[0] as { id?: string } | undefined
      const second = prompt.mock.calls[1]?.[0] as { id?: string } | undefined
      expect(first?.id).toMatch(/^msg_/)
      expect(second?.id).toBe(first?.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it("retries a failed delivery with the same id and the same content", async () => {
    vi.useFakeTimers()
    try {
      const { manager, prompt, sessionGet } = createHarness()
      vi.setSystemTime(new Date(10_000))
      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(9_000), idle: new Date(9_500) },
      })
      // 上游可能已经收到，只是响应丢了。
      prompt.mockRejectedValueOnce(new Error("timeout"))
      await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
      expect(prompt).toHaveBeenCalledTimes(1)

      vi.setSystemTime(new Date(20_000))
      await manager.resumeBuffered()
      expect(prompt).toHaveBeenCalledTimes(2)

      const first = prompt.mock.calls[0]?.[0] as { id?: string; text: string } | undefined
      const second = prompt.mock.calls[1]?.[0] as { id?: string; text: string } | undefined
      expect(second?.id).toBe(first?.id)
      expect(second?.text).toBe(first?.text)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not merge a new message into the batch that is being retried", async () => {
    vi.useFakeTimers()
    try {
      const { manager, prompt, sessionGet } = createHarness()
      vi.setSystemTime(new Date(10_000))
      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(9_000), idle: new Date(9_500) },
      })
      prompt.mockRejectedValueOnce(new Error("timeout"))
      await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
      expect(prompt).toHaveBeenCalledTimes(1)

      // 重试期间又来了一条消息。
      vi.setSystemTime(new Date(20_000))
      await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
      expect(prompt).toHaveBeenCalledTimes(2)

      const first = prompt.mock.calls[0]?.[0] as { id?: string; text: string } | undefined
      const second = prompt.mock.calls[1]?.[0] as { id?: string; text: string } | undefined
      // 重试的必须是原来那一批：同一个 id、同一段内容。
      expect(second?.id).toBe(first?.id)
      expect(second?.text).toBe("第一条")

      // 新到的消息单独成一批，不能混进正在重试的那一批。
      vi.setSystemTime(new Date(30_000))
      await manager.resumeBuffered()
      expect(prompt).toHaveBeenCalledTimes(3)

      const third = prompt.mock.calls[2]?.[0] as { id?: string; text: string } | undefined
      expect(third?.text).toBe("第二条")
      expect(third?.id).not.toBe(first?.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it("drops the batch after the delivery limit and still delivers new messages", async () => {
    vi.useFakeTimers()
    try {
      const { manager, prompt, sessionGet } = createHarness()
      vi.setSystemTime(new Date(10_000))
      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(9_000), idle: new Date(9_500) },
      })
      prompt.mockRejectedValue(new Error("upstream refused"))

      await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
      expect(prompt).toHaveBeenCalledTimes(1)

      // 重试到上限为止，同一批消息一共投递 PENDING_MAX_ATTEMPTS 次。
      await manager.resumeBuffered()
      expect(prompt).toHaveBeenCalledTimes(2)
      await manager.resumeBuffered()
      expect(prompt).toHaveBeenCalledTimes(PENDING_MAX_ATTEMPTS)

      // 超过上限后这一批被丢弃，不会继续重试。
      await manager.resumeBuffered()
      expect(prompt).toHaveBeenCalledTimes(PENDING_MAX_ATTEMPTS)

      // 丢弃之后新到的消息照常投递，不会被堵住。
      prompt.mockResolvedValue(undefined)
      await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
      expect(prompt).toHaveBeenCalledTimes(PENDING_MAX_ATTEMPTS + 1)

      const first = prompt.mock.calls[0]?.[0] as { id?: string } | undefined
      const last = prompt.mock.calls.at(-1)?.[0] as { text?: string; id?: string } | undefined
      expect(last?.text).toBe("第二条")
      expect(last?.id).not.toBe(first?.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it("never reuses an id for a different payload", async () => {
    vi.useFakeTimers()
    try {
      const { manager, prompt, prompts, sessionGet } = createHarness()
      // 模拟上游：同一个 id 带上不同内容会被拒绝。
      const seen = new Map<string, string>()
      const conflicts: string[] = []
      prompt.mockImplementation(async (input: { sessionID: string; text: string; id?: string }) => {
        const key = input.id ?? ""
        const previous = seen.get(key)
        if (previous !== undefined && previous !== input.text) {
          conflicts.push(`${key}: ${previous} -> ${input.text}`)
        }
        seen.set(key, input.text)
        prompts.push(input)
      })

      vi.setSystemTime(new Date(10_000))
      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(9_000), idle: new Date(9_500) },
      })
      prompt.mockRejectedValueOnce(new Error("timeout"))
      await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })

      vi.setSystemTime(new Date(20_000))
      await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })

      vi.setSystemTime(new Date(30_000))
      await manager.resumeBuffered()

      expect(conflicts).toEqual([])
      // 两条消息都要送到上游，且分别使用不同的 id。
      expect(prompts.map((item) => item.text)).toContain("第一条")
      expect(prompts.map((item) => item.text)).toContain("第二条")
      const ids = new Set(prompts.map((item) => item.id))
      expect(ids.size).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("ignores stale end events even when the upstream idle timestamp is older than the newest dispatch", async () => {
    vi.useFakeTimers()
    try {
      const { manager, prompts, sessionGet } = createHarness()
      vi.setSystemTime(new Date(10_000))
      await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
      vi.setSystemTime(new Date(11_000))
      await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
      expect(prompts).toHaveLength(1)

      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(9_000), idle: new Date(10_500) },
      })
      await manager.flushBuffered("session-1")
      expect(prompts).toHaveLength(2)

      vi.setSystemTime(new Date(12_000))
      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(9_000), idle: new Date(10_600) },
      })
      await manager.handleExecutionEnd("session-1", "session.execution.succeeded")
      expect(manager.currentTurn("session-1")?.text).toBe("第二条")
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports whether an incoming message id is new", () => {
    const { manager } = createHarness()
    expect(manager.rememberIncoming(group(100), "message-1")).toBe(true)
    expect(manager.rememberIncoming(group(100), "message-1")).toBe(false)
  })

  it("refuses to bind one session to two targets", async () => {
    const { manager, prompts } = createHarness({ groups: [100, 200] }, () => "session-1")
    await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    expect(prompts).toHaveLength(1)

    // 复用同一个会话 ID 时必须拒绝，否则两个目标会共用一条会话。
    await manager.enqueue(group(200), { text: "第二条", files: [], atMe: false })
    expect(prompts).toHaveLength(1)
    expect(manager.targetForSession("session-1")).toEqual(group(100))
  })

  it("reminds the model when it never called the send tool", async () => {
    const { manager, synthetics } = createHarness()
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    await manager.handleIdle("session-1")
    expect(synthetics).toHaveLength(1)
    expect(synthetics[0]?.text).toContain("qq_send_message")
  })

  it("stops reminding once the send tool was called", async () => {
    const { manager, synthetics } = createHarness()
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    manager.markMessageSent("session-1")
    await manager.handleIdle("session-1")
    expect(synthetics).toHaveLength(0)
  })

  it("caps the number of reminders", async () => {
    const { manager, synthetics } = createHarness({ reminder: { enabled: true, max: 1 } })
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
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
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    expect(prompts).toHaveLength(1)
  })

  it("skips the reminder while background work is still running", async () => {
    const { manager, synthetics } = createHarness()
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    await manager.handleIdle("session-1", [{ sessionID: "session-1" }])
    expect(synthetics).toHaveLength(0)
  })

  it("keeps buffering while its own background work is still running", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    await manager.handleIdle("session-1", [{ sessionID: "session-1" }])

    // 后台任务还在跑，新消息必须排队，不能插进正在执行的会话。
    await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
    expect(prompts).toHaveLength(1)

    await manager.handleIdle("session-1")
    expect(prompts).toHaveLength(1)

    await manager.flushBuffered("session-1")
    expect(prompts).toHaveLength(2)
    expect(prompts[1]?.text).toBe("第二条")
  })

  it("ignores background work owned by descendant sessions", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    manager.markMessageSent("session-1")
    await manager.handleIdle("session-1", [{ sessionID: "child-session" }])

    await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]?.text).toBe("第二条")
  })

  it("resumes delivery after an idle event without buffered messages", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    // 模拟控制类工作只更新会话状态、不触发 idle 钩子。
    await manager.flushBuffered("session-1")
    await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
    expect(prompts).toHaveLength(2)
  })

  it("does not flush the same buffered messages twice", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })

    await manager.flushBuffered("session-1")
    await manager.flushBuffered("session-1")
    expect(prompts).toHaveLength(2)
  })

  it("gives every user turn a fresh reminder budget", async () => {
    const { manager, synthetics } = createHarness({ reminder: { enabled: true, max: 1 } })
    await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    await manager.handleIdle("session-1")
    await manager.handleIdle("session-1")
    expect(synthetics).toHaveLength(1)

    // 新的用户轮次重新获得提醒预算。
    await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
    await manager.handleIdle("session-1")
    expect(synthetics).toHaveLength(2)
  })

  it("releases buffered messages once upstream reports idle", async () => {
    vi.useFakeTimers()
    try {
      const { manager, prompts, sessionGet } = createHarness()
      await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
      await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
      expect(prompts).toHaveLength(1)

      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(1), idle: new Date(2) },
      })
      await vi.advanceTimersByTimeAsync(SUBMIT_GRACE_MS + 1)
      await manager.resumeBuffered()
      expect(prompts).toHaveLength(2)
      expect(prompts[1]?.text).toBe("第二条")
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not rely on periodic resume to flush an already ended run", async () => {
    vi.useFakeTimers()
    try {
      const { manager, prompts, sessionGet } = createHarness()
      vi.setSystemTime(new Date(10_000))
      await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
      vi.setSystemTime(new Date(11_000))
      await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
      expect(prompts).toHaveLength(1)

      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(9_500), idle: new Date(11_500) },
      })
      await manager.handleExecutionEnd("session-1", "session.execution.succeeded")
      expect(prompts).toHaveLength(2)
      expect(prompts[1]?.text).toBe("第二条")
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps buffering while upstream is still running", async () => {
    vi.useFakeTimers()
    try {
      const { manager, prompts, sessionGet } = createHarness()
      await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
      await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })

      // 上游还在执行：即使本地已经忙碌很久，也不能强行放行。
      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(2), idle: undefined },
      })
      await vi.advanceTimersByTimeAsync(SUBMIT_GRACE_MS + 1)
      await manager.resumeBuffered()
      expect(prompts).toHaveLength(1)

      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(2), idle: new Date(1) },
      })
      await manager.resumeBuffered()
      expect(prompts).toHaveLength(1)

      sessionGet.mockResolvedValue({ id: "session-1", time: { busy: 2, idle: 3 } })
      await manager.resumeBuffered()
      expect(prompts).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("releases buffered messages when the upstream end event is lost", async () => {
    vi.useFakeTimers()
    try {
      const { manager, prompts, sessionGet } = createHarness()
      vi.setSystemTime(new Date(10_000))
      await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
      expect(prompts).toHaveLength(1)

      // 上游还在跑，第二条留在缓存里。
      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(10_500), idle: new Date(9_500) },
      })
      await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
      expect(prompts).toHaveLength(1)

      // 结束事件丢了：上游已经空闲，插件没收到任何结束事件。
      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(10_500), idle: new Date(20_000) },
      })
      await vi.advanceTimersByTimeAsync(RESUME_INTERVAL_MS)
      expect(prompts).toHaveLength(2)
      expect(prompts[1]?.text).toBe("第二条")

      // 消息都投出去了，兜底轮询随之停下。
      await vi.advanceTimersByTimeAsync(RESUME_INTERVAL_MS * 3)
      expect(prompts).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not interrupt a running turn while polling the buffer", async () => {
    vi.useFakeTimers()
    try {
      const { manager, prompts, sessionGet } = createHarness()
      vi.setSystemTime(new Date(10_000))
      await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })

      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(10_500), idle: new Date(9_500) },
      })
      await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
      expect(prompts).toHaveLength(1)

      // 上游还在执行，兜底轮询不能强行放行。
      await vi.advanceTimersByTimeAsync(RESUME_INTERVAL_MS)
      expect(prompts).toHaveLength(1)

      // 上游空闲后再等一轮就投出去。
      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(10_500), idle: new Date(45_000) },
      })
      await vi.advanceTimersByTimeAsync(RESUME_INTERVAL_MS)
      expect(prompts).toHaveLength(2)
      expect(prompts[1]?.text).toBe("第二条")
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops the buffer watchdog after the plugin is unloaded", async () => {
    vi.useFakeTimers()
    try {
      const { manager, prompts } = createHarness()
      vi.setSystemTime(new Date(10_000))
      await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
      await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
      expect(prompts).toHaveLength(1)

      manager.dispose()
      await vi.advanceTimersByTimeAsync(RESUME_INTERVAL_MS)
      expect(prompts).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not keep its own busy flag when upstream is idle", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    // 上游已经结束，本地不需要额外的释放动作。
    await manager.flushBuffered("session-1")

    await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]?.text).toBe("第二条")
  })

  it("resumes buffered messages when the model execution fails", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
    expect(prompts).toHaveLength(1)

    await manager.handleExecutionEnd("session-1", "session.execution.failed")
    expect(prompts).toHaveLength(2)
    expect(prompts[1]?.text).toBe("第二条")
  })

  it("posts a fixed notice when a turn fails before the model replies", async () => {
    const { manager, notices } = createHarness()
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    await manager.handleExecutionEnd("session-1", "session.execution.failed", "provider 500")
    expect(notices).toEqual([{ target: group(100), text: FAILURE_NOTICE }])
  })

  it("stays quiet when the model already sent a reply", async () => {
    const { manager, notices } = createHarness()
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    manager.markMessageSent("session-1")
    await manager.handleExecutionEnd("session-1", "session.execution.failed")
    expect(notices).toHaveLength(0)
  })

  it("does not apologise for a failed proactive turn", async () => {
    const { manager, notices } = createHarness()
    await manager.enqueue(group(100), { text: "主动说话", files: [], atMe: false, proactive: true })
    await manager.handleExecutionEnd("session-1", "session.execution.failed")
    expect(notices).toHaveLength(0)
  })

  it("uses the interrupted notice when the turn is aborted", async () => {
    const { manager, notices } = createHarness()
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    await manager.handleExecutionEnd("session-1", "session.execution.interrupted")
    expect(notices).toEqual([{ target: group(100), text: INTERRUPTED_NOTICE }])
  })

  it("throttles failure notices per target", async () => {
    vi.useFakeTimers()
    try {
      const { manager, notices } = createHarness()
      vi.setSystemTime(new Date(10_000))
      await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
      await manager.handleExecutionEnd("session-1", "session.execution.failed")

      // 冷却期内再失败一次，不再补提示。
      await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
      await manager.handleExecutionEnd("session-1", "session.execution.failed")
      expect(notices).toHaveLength(1)

      // 过了冷却期才允许再提示一次。
      vi.setSystemTime(new Date(10_000 + FAILURE_NOTICE_INTERVAL_MS))
      await manager.enqueue(group(100), { text: "第三条", files: [], atMe: false })
      await manager.handleExecutionEnd("session-1", "session.execution.failed")
      expect(notices).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("tells the chat when a batch is dropped after the delivery limit", async () => {
    vi.useFakeTimers()
    try {
      const { manager, prompt, sessionGet, notices } = createHarness()
      vi.setSystemTime(new Date(10_000))
      sessionGet.mockResolvedValue({
        id: "session-1",
        time: { busy: new Date(9_000), idle: new Date(9_500) },
      })
      prompt.mockRejectedValue(new Error("upstream refused"))

      await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
      // 第 2 次失败，仍保留这批消息。
      await manager.resumeBuffered()
      expect(notices).toHaveLength(0)

      // 这一轮重试到上限，批次被丢弃，群里补一条提示。
      await manager.resumeBuffered()
      expect(notices).toEqual([{ target: group(100), text: FAILURE_NOTICE }])
    } finally {
      vi.useRealTimers()
    }
  })

  it("creates only one session for concurrent ensureSession calls", async () => {
    const { manager } = createHarness()
    const [first, second] = await Promise.all([
      manager.ensureSession(group(100)),
      manager.ensureSession(group(100)),
    ])
    expect(first).toBe("session-1")
    expect(second).toBe("session-1")
  })

  it("rebuilds a binding when the restored session no longer exists", async () => {
    const { manager, prompts, sessionGet } = createHarness({}, undefined, {
      "group:100": "gone",
    })
    sessionGet.mockRejectedValueOnce(new Error("not found"))
    await manager.load()
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    expect(prompts[0]?.sessionID).toBe("session-1")
    expect(manager.targetForSession("gone")).toBeUndefined()
  })

  it("does not create a proactive turn while a turn is active", async () => {
    const { manager, synthetics } = createHarness()
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    await manager.proactive(group(100), "主动话题")
    expect(synthetics).toHaveLength(0)
  })

  it("drops the oldest buffered messages when the buffer is full", async () => {
    const { manager, prompts } = createHarness()
    await manager.enqueue(group(100), { text: "first", files: [], atMe: false })
    for (let index = 0; index < MAX_BUFFER_TURNS + 5; index += 1) {
      await manager.enqueue(group(100), { text: `buffered-${index}`, files: [], atMe: false })
    }
    await manager.handleIdle("session-1")
    await manager.flushBuffered("session-1")
    const merged = prompts[1]?.text ?? ""
    expect(merged).not.toContain("buffered-0")
    expect(merged).toContain(`buffered-${MAX_BUFFER_TURNS + 4}`)
  })

  it("flushes bindings and activity to storage", async () => {
    const { manager, storage } = createHarness()
    manager.touch(group(100))
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    await manager.flush()
    expect(storage.set).toHaveBeenCalledWith("bindings", { "group:100": "session-1" })
    expect(storage.set).toHaveBeenCalledWith(
      "activity",
      expect.objectContaining({ "group:100": expect.any(Number) }),
    )
  })
})

describe("B1 冷启动补历史", () => {
  /** 造一个能记录调用参数的历史来源。 */
  function historyProvider(text: string) {
    return {
      fetch: vi.fn(async (_target: ChatTarget, _options: HistoryOptions) => ({ text, files: [] })),
    }
  }

  it("新建会话时把最近的历史拼在首轮消息前面", async () => {
    const history = historyProvider("<history>\n小明: 早上好\n</history>")
    const { manager, prompts } = createHarness({}, undefined, undefined, history)
    await manager.enqueue(group(100), {
      text: "你好",
      files: [],
      atMe: false,
      source: { id: "9", time: 900 },
    })
    expect(prompts[0]?.text).toBe("<history>\n小明: 早上好\n</history>\n你好")
    const options = history.fetch.mock.calls[0]?.[1]
    expect(options?.count).toBe(20)
    expect(options?.since).toBeUndefined()
  })

  it("恢复会话时只补上次位置之后的增量", async () => {
    const history = historyProvider("<history>\n离线期间的消息\n</history>")
    const { manager, prompts } = createHarness(
      {},
      undefined,
      { "group:100": "session-restored" },
      history,
      { "group:100": { id: "5", time: 100 } },
    )
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    expect(prompts[0]?.sessionID).toBe("session-restored")
    const options = history.fetch.mock.calls[0]?.[1]
    expect(options?.since).toEqual({ id: "5", time: 100 })
  })

  it("history.count 为 0 时关闭回填", async () => {
    const history = historyProvider("<history>\n不该出现\n</history>")
    const { manager, prompts } = createHarness(
      { history: { count: 0 } },
      undefined,
      undefined,
      history,
    )
    await manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    expect(history.fetch).not.toHaveBeenCalled()
    expect(prompts[0]?.text).toBe("你好")
  })

  it("每个目标每次运行只补一次", async () => {
    const history = historyProvider("<history>\n旧消息\n</history>")
    const { manager } = createHarness({}, undefined, undefined, history)
    await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
    expect(history.fetch).toHaveBeenCalledTimes(1)
  })

  it("补历史失败后下一轮继续补", async () => {
    const history = {
      fetch: vi
        .fn()
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValueOnce({ text: "<history>\n补上了\n</history>", files: [] }),
    }
    const { manager, prompts } = createHarness({}, undefined, undefined, history)
    await manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    expect(prompts[0]?.text).toBe("第一条")

    await manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
    await manager.handleIdle("session-1")
    await manager.flushBuffered("session-1")

    expect(history.fetch).toHaveBeenCalledTimes(2)
    expect(prompts[1]?.text).toBe("<history>\n补上了\n</history>\n第二条")
  })

  it("投递成功后把位置写进存储", async () => {
    const { manager, storage } = createHarness()
    await manager.enqueue(group(100), {
      text: "你好",
      files: [],
      atMe: false,
      source: { id: "7", time: 200 },
    })
    await manager.flush()
    expect(storage.set).toHaveBeenCalledWith("positions", {
      "group:100": { id: "7", time: 200 },
    })
  })

  it("activeTurn 汇总目标、轮次与角色", async () => {
    const harness = createHarness()
    await harness.manager.enqueue(group(100), {
      text: "你好",
      files: [],
      atMe: false,
      role: "admin",
    })

    const active = harness.manager.activeTurn("session-1")
    expect(active?.target).toEqual(group(100))
    expect(active?.turn.text).toBe("你好")
    expect(active?.role).toBe("admin")
    expect(harness.manager.activeTurn("session-x")).toBeUndefined()
  })

  it("重置聊天时打断执行中的回合并解绑会话", async () => {
    const harness = createHarness()
    await harness.manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    harness.sessionGet.mockResolvedValue({ id: "session-1", time: { busy: 2_000, idle: 0 } })

    const result = await harness.manager.resetTarget(group(100))

    expect(result).toEqual({ sessionID: "session-1", interrupted: true })
    expect(harness.sessionInterrupt).toHaveBeenCalledWith({ sessionID: "session-1" })
    expect(harness.sessionRemove).toHaveBeenCalledWith({ sessionID: "session-1" })
    expect(harness.manager.targetForSession("session-1")).toBeUndefined()
    expect(harness.manager.snapshot()[0]?.sessionID).toBeUndefined()

    // 下一条消息重新建会话。
    await harness.manager.enqueue(group(100), { text: "再来", files: [], atMe: false })
    expect(harness.prompts.at(-1)?.sessionID).toBe("session-2")
  })

  it("重置空闲聊天时不动上游会话之外的状态", async () => {
    const harness = createHarness()
    await harness.manager.enqueue(group(100), { text: "你好", files: [], atMe: false })
    harness.sessionGet.mockResolvedValue({ id: "session-1" })

    const result = await harness.manager.resetTarget(group(100))

    expect(result.interrupted).toBe(false)
    expect(harness.sessionInterrupt).not.toHaveBeenCalled()
    expect(harness.sessionRemove).toHaveBeenCalledWith({ sessionID: "session-1" })
  })

  it("合并批次时按最低权限保留角色", () => {
    expect(
      mergeTurns([
        { text: "a", files: [], atMe: false, role: "owner" },
        { text: "b", files: [], atMe: false, role: "member" },
      ]).role,
    ).toBe("member")
    expect(
      mergeTurns([
        { text: "a", files: [], atMe: false, role: "admin" },
        { text: "b", files: [], atMe: false, role: "owner" },
      ]).role,
    ).toBe("admin")
  })

  it("合并批次时保留最后一条消息的位置", () => {
    const merged = mergeTurns([
      { text: "a", files: [], atMe: false, source: { id: "1", time: 1 } },
      { text: "b", files: [], atMe: false, source: { id: "2", time: 2 } },
    ])
    expect(merged.source).toEqual({ id: "2", time: 2 })
  })
})
