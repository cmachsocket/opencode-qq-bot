import { describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin"
import { DEFAULT_CONFIG, type QQBotConfig } from "../src/config"
import {
  KEEP_ALIVE_SESSION_KEY,
  KEEP_ALIVE_SESSION_MARKER,
  KEEP_ALIVE_TITLE,
  KeepAlive,
} from "../src/keepalive"
import type { Logger } from "../src/logger"

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger

interface SessionRecord {
  id: string
  title?: string
  metadata?: Record<string, unknown>
}

function createHarness() {
  const sessions = new Map<string, SessionRecord>()
  const storage = new Map<string, unknown>()
  const updates: Array<{ sessionID: string; metadata?: Record<string, unknown> }> = []
  let created = 0

  const ctx = {
    location: { directory: "/tmp/qq-bot" },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
    },
    session: {
      create: async (input: { title?: string; metadata?: Record<string, unknown> }) => {
        created += 1
        const id = `ses_${created}`
        sessions.set(id, { id, title: input.title, metadata: input.metadata })
        return { id }
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        const record = sessions.get(sessionID)
        if (!record) throw new Error(`会话 ${sessionID} 不存在`)
        return record
      },
      update: async (input: { sessionID: string; metadata?: Record<string, unknown> }) => {
        const record = sessions.get(input.sessionID)
        if (!record) throw new Error(`会话 ${input.sessionID} 不存在`)
        record.metadata = input.metadata
        updates.push(input)
      },
      list: async () => ({ data: [...sessions.values()], cursor: {} }),
    },
  } as unknown as Plugin.Context

  return {
    ctx,
    sessions,
    storage,
    updates,
    createdCount: () => created,
  }
}

function createConfig(overrides: Partial<QQBotConfig> = {}): QQBotConfig {
  return {
    ...DEFAULT_CONFIG,
    napcat: { url: "ws://127.0.0.1:3001" },
    ...overrides,
  }
}

describe("KeepAlive", () => {
  it("新建一个专用会话并原样写回元数据", async () => {
    const harness = createHarness()
    const keepAlive = new KeepAlive(harness.ctx, createConfig(), logger)

    await keepAlive.ping()

    expect(harness.createdCount()).toBe(1)
    const record = [...harness.sessions.values()][0]
    expect(record?.title).toBe(KEEP_ALIVE_TITLE)
    expect(record?.metadata).toEqual({ [KEEP_ALIVE_SESSION_MARKER]: true })
    expect(harness.updates).toHaveLength(1)
    expect(harness.updates[0]?.sessionID).toBe(record?.id)
    expect(harness.updates[0]?.metadata).toEqual({ [KEEP_ALIVE_SESSION_MARKER]: true })
    expect(harness.storage.get(KEEP_ALIVE_SESSION_KEY)).toBe(record?.id)
  })

  it("写回时保留会话原有的其它元数据", async () => {
    const harness = createHarness()
    harness.sessions.set("ses_existing", {
      id: "ses_existing",
      metadata: { qqTargetKind: "group", qqTargetId: 123 },
    })
    harness.storage.set(KEEP_ALIVE_SESSION_KEY, "ses_existing")
    const keepAlive = new KeepAlive(harness.ctx, createConfig(), logger)

    await keepAlive.ping()

    expect(harness.createdCount()).toBe(0)
    expect(harness.updates[0]?.metadata).toEqual({ qqTargetKind: "group", qqTargetId: 123 })
  })

  it("上次保存的会话已经消失时重新建一个", async () => {
    const harness = createHarness()
    harness.storage.set(KEEP_ALIVE_SESSION_KEY, "ses_gone")
    const keepAlive = new KeepAlive(harness.ctx, createConfig(), logger)

    await keepAlive.ping()

    expect(harness.createdCount()).toBe(1)
    expect(harness.storage.get(KEEP_ALIVE_SESSION_KEY)).toBe("ses_1")
  })

  it("按标记找回已经建好的保活会话", async () => {
    const harness = createHarness()
    harness.sessions.set("ses_marked", {
      id: "ses_marked",
      metadata: { [KEEP_ALIVE_SESSION_MARKER]: true },
    })
    const keepAlive = new KeepAlive(harness.ctx, createConfig(), logger)

    await keepAlive.ping()

    expect(harness.createdCount()).toBe(0)
    expect(harness.updates[0]?.sessionID).toBe("ses_marked")
    expect(harness.storage.get(KEEP_ALIVE_SESSION_KEY)).toBe("ses_marked")
  })

  it("关闭保活时不产生任何心跳", async () => {
    const harness = createHarness()
    const config = createConfig({ keepAlive: { enabled: false, seconds: 60 } })
    const keepAlive = new KeepAlive(harness.ctx, config, logger)

    keepAlive.start()
    await Promise.resolve()

    expect(harness.createdCount()).toBe(0)
    expect(harness.updates).toHaveLength(0)
  })

  it("按间隔重复心跳，卸载后停止", async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness()
      const keepAlive = new KeepAlive(
        harness.ctx,
        createConfig({ keepAlive: { enabled: true, seconds: 60 } }),
        logger,
      )

      keepAlive.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(harness.updates).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(harness.updates).toHaveLength(2)

      keepAlive.dispose()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(harness.updates).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("写回失败时只告警，不丢掉会话", async () => {
    const harness = createHarness()
    const failing = {
      ...harness.ctx,
      session: {
        ...harness.ctx.session,
        update: async () => {
          throw new Error("上游不可用")
        },
      },
    } as unknown as Plugin.Context
    const keepAlive = new KeepAlive(failing, createConfig(), logger)

    await keepAlive.ping()

    expect(logger.warn).toHaveBeenCalled()
    expect(harness.createdCount()).toBe(1)
  })
})
