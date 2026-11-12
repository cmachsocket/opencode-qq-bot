import { beforeEach, describe, expect, it, vi } from "vitest"
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

const WORKSPACE = "/tmp/qq-bot"

interface SessionRecord {
  id: string
  title?: string
  metadata?: Record<string, unknown>
  directory?: string
  archived?: boolean
}

interface UpdateInput {
  sessionID: string
  metadata?: Record<string, unknown>
  archived?: boolean
}

function createHarness(
  options: { supportArchive?: boolean; notFound?: boolean; updateNotFound?: boolean } = {},
) {
  const sessions = new Map<string, SessionRecord>()
  const storage = new Map<string, unknown>()
  const updates: UpdateInput[] = []
  let created = 0
  let updateNotFoundUsed = false

  /** 上游表示“会话不存在”的错误：只有名字，没有 message。 */
  const missing = (sessionID: string) => {
    if (!options.notFound && !options.updateNotFound) return new Error(`会话 ${sessionID} 不存在`)
    const error = new Error()
    error.name = "Session.NotFoundError"
    return error
  }

  const ctx = {
    location: { directory: WORKSPACE },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
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
        if (!record) throw missing(sessionID)
        return {
          ...record,
          location: { directory: record.directory ?? WORKSPACE },
          time: { created: 0, updated: 0, archived: record.archived ? 1 : undefined },
        }
      },
      update: async (input: UpdateInput) => {
        const record = sessions.get(input.sessionID)
        if (!record) throw missing(input.sessionID)
        // 上游在写回元数据时发现会话没了，行为和会话被删掉一样。
        if (options.updateNotFound && input.metadata !== undefined && !updateNotFoundUsed) {
          updateNotFoundUsed = true
          sessions.delete(input.sessionID)
          throw missing(input.sessionID)
        }
        if (input.metadata !== undefined) record.metadata = input.metadata
        // 上游的插件接口目前忽略 archived，只在支持归档时才生效。
        if (options.supportArchive && input.archived !== undefined) {
          record.archived = input.archived
        }
        updates.push(input)
      },
      remove: async ({ sessionID }: { sessionID: string }) => {
        if (!sessions.has(sessionID)) throw missing(sessionID)
        sessions.delete(sessionID)
      },
      list: async ({ directory }: { directory?: string } = {}) => ({
        data: [...sessions.values()].filter(
          (record) => !directory || (record.directory ?? WORKSPACE) === directory,
        ),
        cursor: {},
      }),
    },
  } as unknown as Plugin.Context

  const metadataUpdates = () => updates.filter((update) => update.metadata !== undefined)

  return {
    ctx,
    sessions,
    storage,
    updates,
    metadataUpdates,
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
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("新建一个专用会话并原样写回元数据", async () => {
    const harness = createHarness()
    const keepAlive = new KeepAlive(harness.ctx, createConfig(), logger)

    await keepAlive.ping()

    expect(harness.createdCount()).toBe(1)
    const record = [...harness.sessions.values()][0]
    expect(record?.title).toBe(KEEP_ALIVE_TITLE)
    expect(record?.metadata).toEqual({ [KEEP_ALIVE_SESSION_MARKER]: true })
    expect(harness.metadataUpdates()).toHaveLength(1)
    expect(harness.metadataUpdates()[0]?.sessionID).toBe(record?.id)
    expect(harness.metadataUpdates()[0]?.metadata).toEqual({ [KEEP_ALIVE_SESSION_MARKER]: true })
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
    expect(harness.metadataUpdates()[0]?.metadata).toEqual({
      qqTargetKind: "group",
      qqTargetId: 123,
    })
  })

  it("上次保存的会话已经消失时重新建一个", async () => {
    const harness = createHarness()
    harness.storage.set(KEEP_ALIVE_SESSION_KEY, "ses_gone")
    const keepAlive = new KeepAlive(harness.ctx, createConfig(), logger)

    await keepAlive.ping()

    expect(harness.createdCount()).toBe(1)
    expect(harness.storage.get(KEEP_ALIVE_SESSION_KEY)).toBe("ses_1")
  })

  it("存储里是别的目录的会话时不复用", async () => {
    const harness = createHarness()
    harness.sessions.set("ses_elsewhere", {
      id: "ses_elsewhere",
      directory: "/tmp/other-project",
      metadata: { [KEEP_ALIVE_SESSION_MARKER]: true },
    })
    harness.storage.set(KEEP_ALIVE_SESSION_KEY, "ses_elsewhere")
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
    expect(harness.metadataUpdates()[0]?.sessionID).toBe("ses_marked")
    expect(harness.storage.get(KEEP_ALIVE_SESSION_KEY)).toBe("ses_marked")
  })

  it("给保活会话请求归档，让它不出现在会话列表里", async () => {
    const harness = createHarness()
    const keepAlive = new KeepAlive(harness.ctx, createConfig(), logger)

    await keepAlive.ping()

    const archive = harness.updates.find((update) => update.archived !== undefined)
    expect(archive?.archived).toBe(true)
    expect(archive?.sessionID).toBe("ses_1")
  })

  it("上游支持归档时把保活会话标记为已归档", async () => {
    const harness = createHarness({ supportArchive: true })
    const keepAlive = new KeepAlive(harness.ctx, createConfig(), logger)

    await keepAlive.ping()

    expect(harness.sessions.get("ses_1")?.archived).toBe(true)
    expect(logger.info).toHaveBeenCalledWith("保活会话 ses_1 已归档")
  })

  it("上游忽略归档时如实记录会话仍会显示在列表里", async () => {
    const harness = createHarness()
    const keepAlive = new KeepAlive(harness.ctx, createConfig(), logger)

    await keepAlive.ping()

    expect(harness.sessions.get("ses_1")?.archived).toBeUndefined()
    expect(logger.info).toHaveBeenCalledWith("上游未支持归档保活会话 ses_1，它会显示在会话列表里")
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
      expect(harness.metadataUpdates()).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(harness.metadataUpdates()).toHaveLength(2)

      await keepAlive.dispose()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(harness.metadataUpdates()).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("卸载时删掉保活会话并清掉存储记录", async () => {
    const harness = createHarness()
    const keepAlive = new KeepAlive(harness.ctx, createConfig(), logger)

    await keepAlive.ping()
    await keepAlive.dispose()

    expect(harness.sessions.has("ses_1")).toBe(false)
    expect(harness.storage.get(KEEP_ALIVE_SESSION_KEY)).toBeUndefined()
  })

  it("卸载时不删掉别的项目留下的存储记录", async () => {
    const harness = createHarness()
    const keepAlive = new KeepAlive(harness.ctx, createConfig(), logger)

    await keepAlive.ping()
    harness.storage.set(KEEP_ALIVE_SESSION_KEY, "ses_other_project")
    await keepAlive.dispose()

    expect(harness.storage.get(KEEP_ALIVE_SESSION_KEY)).toBe("ses_other_project")
  })

  it("卸载后不再心跳，不会把会话写回来", async () => {
    const harness = createHarness()
    const keepAlive = new KeepAlive(harness.ctx, createConfig(), logger)

    await keepAlive.ping()
    await keepAlive.dispose()
    await keepAlive.ping()

    expect(harness.metadataUpdates()).toHaveLength(1)
    expect(harness.createdCount()).toBe(1)
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

  it("上游说会话没了就当场重建，不用等下一个心跳", async () => {
    const harness = createHarness({ notFound: true })
    const keepAlive = new KeepAlive(harness.ctx, createConfig(), logger)

    await keepAlive.ping()
    expect(harness.createdCount()).toBe(1)

    // 上游把保活会话删掉了。
    harness.sessions.delete("ses_1")
    await keepAlive.ping()

    expect(harness.createdCount()).toBe(2)
    expect(harness.storage.get(KEEP_ALIVE_SESSION_KEY)).toBe("ses_2")
    expect(harness.metadataUpdates().at(-1)?.sessionID).toBe("ses_2")
    expect(logger.warn).toHaveBeenCalledWith("保活会话 ses_1 已不存在，正在重建")
  })

  it("写回元数据时上游说会话没了也当场重建", async () => {
    const harness = createHarness({ updateNotFound: true })
    const keepAlive = new KeepAlive(harness.ctx, createConfig(), logger)

    await keepAlive.ping()

    expect(harness.createdCount()).toBe(2)
    expect(harness.storage.get(KEEP_ALIVE_SESSION_KEY)).toBe("ses_2")
    expect(harness.metadataUpdates().at(-1)?.sessionID).toBe("ses_2")
    expect(logger.warn).toHaveBeenCalledWith("保活会话 ses_1 已不存在，正在重建")
    expect(logger.warn).not.toHaveBeenCalledWith("重建保活会话失败", expect.anything())
  })

  it("存储里的保活会话没了就清掉记录再建一个", async () => {
    const harness = createHarness({ notFound: true })
    harness.storage.set(KEEP_ALIVE_SESSION_KEY, "ses_gone")
    const keepAlive = new KeepAlive(harness.ctx, createConfig(), logger)

    await keepAlive.ping()

    expect(harness.createdCount()).toBe(1)
    expect(harness.storage.get(KEEP_ALIVE_SESSION_KEY)).toBe("ses_1")
  })
})
