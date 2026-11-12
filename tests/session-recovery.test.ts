import { describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin"
import { SessionManager } from "../src/session/manager"
import { DEFAULT_CONFIG, type QQBotConfig } from "../src/config"
import type { ChatTarget } from "../src/chat"
import type { Logger } from "../src/logger"
import { accessConfig } from "./fixtures"

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const group = (id: number): ChatTarget => ({ kind: "group", id })

/** 列表里出现的一条会话。 */
interface FakeSession {
  id: string
  metadata?: Record<string, unknown>
  /** 会话里的消息条数。 */
  messages?: number
}

interface HarnessOptions {
  /** 存储里已有的绑定：目标键 → 会话 ID。 */
  stored?: Record<string, string>
  /** 直查（session.get）能取到的会话；不在其中就报 NotFound。 */
  existing?: string[]
  /** 列表查询（session.list）返回的会话。 */
  listed?: FakeSession[]
  /** 是否打开会话复用。 */
  reuseSession?: boolean
}

interface Harness {
  manager: SessionManager
  session: {
    get: ReturnType<typeof vi.fn>
    list: ReturnType<typeof vi.fn>
    context: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
  }
  storage: {
    get: ReturnType<typeof vi.fn>
    set: ReturnType<typeof vi.fn>
  }
  /** 每次落盘的绑定快照。 */
  bindings: Array<Record<string, string>>
}

function createHarness(options: HarnessOptions = {}): Harness {
  const existing = new Set(options.existing ?? [])
  const listed = options.listed ?? []
  const bindings: Array<Record<string, string>> = []

  const storage = {
    get: vi.fn(async (key: string) => {
      if (key === "bindings") return options.stored
      return undefined
    }),
    set: vi.fn(async (key: string, value: unknown) => {
      if (key === "bindings") bindings.push(value as Record<string, string>)
    }),
  }

  let created = 0
  const session = {
    get: vi.fn(async (input: { sessionID: string }) => {
      if (!existing.has(input.sessionID)) throw new Error("Session.NotFoundError")
      return { id: input.sessionID }
    }),
    list: vi.fn(async () => ({ data: listed, cursor: {} })),
    context: vi.fn(async (input: { sessionID: string }) => {
      const found = listed.find((item) => item.id === input.sessionID)
      return Array.from({ length: found?.messages ?? 0 }, (_, index) => ({ id: `msg-${index}` }))
    }),
    create: vi.fn(async () => {
      created += 1
      return { id: `ses-new-${created}` }
    }),
    remove: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    synthetic: vi.fn(async () => {}),
    switchAgent: vi.fn(async () => {}),
    switchModel: vi.fn(async () => {}),
  }

  const ctx = {
    location: { directory: "/tmp" },
    storage,
    session,
  } as unknown as Plugin.Context

  const config: QQBotConfig = {
    ...DEFAULT_CONFIG,
    napcat: { url: "ws://127.0.0.1:3001" },
    access: accessConfig({ groups: [100] }),
    reuseSession: options.reuseSession ?? false,
  }

  const manager = new SessionManager(ctx, config, logger, { directory: "/tmp" })

  return { manager, session, storage, bindings }
}

const target = group(100)
const metadata = { qqTargetKind: "group", qqTargetId: 100 }

describe("会话丢了之后不重建", () => {
  it("直查失败但目录列表里还在 → 继续用同一个会话", async () => {
    const { manager, session } = createHarness({
      stored: { "group:100": "ses_old" },
      existing: [],
      listed: [{ id: "ses_old", metadata }],
    })

    expect(await manager.ensureSession(target)).toBe("ses_old")
    expect(session.create).not.toHaveBeenCalled()
  })

  it("旧会话彻底没了 → 找回同一个聊天上消息最多的那条", async () => {
    const { manager, session } = createHarness({
      stored: { "group:100": "ses_gone" },
      existing: [],
      listed: [
        { id: "ses_empty", metadata, messages: 0 },
        { id: "ses_rich", metadata, messages: 12 },
      ],
    })

    expect(await manager.ensureSession(target)).toBe("ses_rich")
    expect(session.create).not.toHaveBeenCalled()
  })

  it("找回成功时绑定直接换成旧会话，不会先落一个空绑定", async () => {
    const { manager, bindings } = createHarness({
      stored: { "group:100": "ses_gone" },
      existing: [],
      listed: [{ id: "ses_rich", metadata, messages: 12 }],
    })

    await manager.ensureSession(target)
    await manager.flush()

    expect(bindings.length).toBeGreaterThan(0)
    for (const snapshot of bindings) {
      expect(snapshot["group:100"]).toBe("ses_rich")
    }
  })

  it("既没有旧会话也没有候选 → 才新建会话", async () => {
    const { manager, session } = createHarness({
      stored: { "group:100": "ses_gone" },
      existing: [],
      listed: [],
    })

    expect(await manager.ensureSession(target)).toBe("ses-new-1")
    expect(session.create).toHaveBeenCalledTimes(1)
  })

  it("别的聊天的会话不会被当成候选", async () => {
    const { manager, session } = createHarness({
      stored: { "group:100": "ses_gone" },
      existing: [],
      listed: [
        { id: "ses_other", metadata: { qqTargetKind: "group", qqTargetId: 999 }, messages: 30 },
      ],
    })

    expect(await manager.ensureSession(target)).toBe("ses-new-1")
    expect(session.create).toHaveBeenCalledTimes(1)
  })

  it("没有绑定也没有候选时行为不变：仍然新建会话", async () => {
    const { manager, session } = createHarness({
      existing: [],
      listed: [{ id: "ses_rich", metadata, messages: 12 }],
    })

    expect(await manager.ensureSession(target)).toBe("ses-new-1")
    expect(session.create).toHaveBeenCalledTimes(1)
  })

  it("打开复用开关时取最近的那条会话", async () => {
    const { manager, session } = createHarness({
      existing: [],
      listed: [
        { id: "ses_empty", metadata, messages: 0 },
        { id: "ses_rich", metadata, messages: 12 },
      ],
      reuseSession: true,
    })

    // 列表按创建时间倒序，第一条就是「上一次的会话」：复用要的是最近的那条，
    // 不是消息最多的那条（那是找回路径要的）。
    expect(await manager.ensureSession(target)).toBe("ses_empty")
    expect(session.create).not.toHaveBeenCalled()
  })

  it("候选会话读不到消息时按 0 条算，不影响找回", async () => {
    const { manager, session } = createHarness({
      stored: { "group:100": "ses_gone" },
      existing: [],
      listed: [{ id: "ses_rich", metadata }],
    })
    session.context.mockRejectedValue(new Error("read failed"))

    expect(await manager.ensureSession(target)).toBe("ses_rich")
    expect(session.create).not.toHaveBeenCalled()
  })
})
