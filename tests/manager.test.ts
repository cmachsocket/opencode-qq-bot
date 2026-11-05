import { describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin"
import {
  MAX_BUFFER_TURNS,
  SUBMIT_GRACE_MS,
  SessionManager,
  mergeTurns,
} from "../src/session/manager"
import { DEFAULT_CONFIG, type QQBotConfig } from "../src/config"
import type { ChatTarget } from "../src/chat"
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
  prompts: Array<{ sessionID: string; text: string; id?: string }>
  prompt: ReturnType<typeof vi.fn>
  synthetics: Array<{ sessionID: string; text: string }>
  storage: {
    get: ReturnType<typeof vi.fn>
    set: ReturnType<typeof vi.fn>
  }
  sessionGet: ReturnType<typeof vi.fn>
  sessionCreate: ReturnType<typeof vi.fn>
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
  const prompt = vi.fn(async (input: { sessionID: string; text: string; id?: string }) => {
    prompts.push(input)
  })

  const ctx = {
    location: { directory: "/tmp" },
    storage,
    session: {
      create: sessionCreate,
      get: sessionGet,
      remove: vi.fn(async () => {}),
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
    manager: new SessionManager(ctx, config, logger),
    prompts,
    prompt,
    synthetics,
    storage,
    sessionGet,
    sessionCreate,
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
