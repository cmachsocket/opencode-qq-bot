import { afterEach, describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

/** 存储里的一条绑定：会话与写入版本。 */
interface StoredBinding {
  sessionID: string
  at: number
}

/** 列表里出现的一条会话。 */
interface FakeSession {
  id: string
  /** 会话所在目录；老版本把会话建在项目目录里。 */
  directory?: string
  title?: string
  metadata?: Record<string, unknown>
}

/** 写入门：让下一次写入卡住，制造读-改-写被穿插的窗口。 */
interface WriteGate {
  /** 写入开始时 resolve。 */
  entered: Promise<void>
  /** 放行这次写入。 */
  release: () => void
}

/** 每个测试用到的临时目录，测试结束后清掉。 */
const tempDirs: string[] = []

/** 临时目录用完就删，不留在磁盘上。 */
function cleanupTempDirs(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 同一台机器上的两个插件实例：共用一张存储表，也共用同一个会话库。
 *
 * 存储是全机器共享的，两个实例各写一份整表时，后写的会把先写的条目冲掉。
 */
function createWorld() {
  const tables = new Map<string, unknown>()
  const sessions = new Set<string>()
  const listed: FakeSession[] = []
  // 写锁放在临时目录里：两个实例共用同一个路径才会互相排队。
  const lockDir = mkdtempSync(join(tmpdir(), "qq-bot-bindings-"))
  tempDirs.push(lockDir)
  const lockPath = join(lockDir, "state.lock")

  /** 卡住下一次写入用的门。 */
  let gate: { entered: () => void; wait: Promise<void> } | undefined

  const storage = {
    get: vi.fn(async (key: string) => tables.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      const current = gate
      if (current) {
        gate = undefined
        current.entered()
        await current.wait
      }
      tables.set(key, value)
    }),
  }

  const createInstance = (prefix: string, options?: { canWrite?: () => boolean }) => {
    let created = 0
    const sessionCreate = vi.fn(async () => {
      created += 1
      const id = `${prefix}-${created}`
      sessions.add(id)
      listed.unshift({
        id,
        directory: "/tmp",
        metadata: { qqTargetKind: "group", qqTargetId: 100 },
      })
      return { id }
    })
    const ctx = {
      location: { directory: "/tmp" },
      storage,
      session: {
        create: sessionCreate,
        get: vi.fn(async (input: { sessionID: string }) => {
          if (!sessions.has(input.sessionID)) throw new Error("Session.NotFoundError")
          return { id: input.sessionID }
        }),
        remove: vi.fn(async () => {}),
        interrupt: vi.fn(async () => {}),
        prompt: vi.fn(async () => {}),
        synthetic: vi.fn(async () => {}),
        list: vi.fn(async (input: { directory?: string }) => ({
          data: listed.filter((item) => !input.directory || item.directory === input.directory),
          cursor: {},
        })),
        switchAgent: vi.fn(async () => {}),
        switchModel: vi.fn(async () => {}),
      },
    } as unknown as Plugin.Context
    const config: QQBotConfig = {
      ...DEFAULT_CONFIG,
      napcat: { url: "ws://127.0.0.1:3001" },
      access: accessConfig({ groups: [100, 200] }),
    }
    return {
      manager: new SessionManager(
        ctx,
        config,
        logger,
        { directory: "/tmp", lockPath },
        undefined,
        undefined,
        undefined,
        undefined,
        options?.canWrite,
      ),
      sessionCreate,
    }
  }

  /** 登记一个已经存在的会话。 */
  const addSession = (session: FakeSession): void => {
    sessions.add(session.id)
    listed.unshift(session)
  }

  /** 存储里当前的绑定表。 */
  const bindings = (): Record<string, StoredBinding> =>
    (tables.get("bindings") ?? {}) as Record<string, StoredBinding>

  /** 存储里当前的解绑记录。 */
  const unbound = (): Record<string, number> =>
    (tables.get("unbound") ?? {}) as Record<string, number>

  /** 会话没了：直查与列表查询都要查不到。 */
  const removeSession = (id: string): void => {
    sessions.delete(id)
    const index = listed.findIndex((item) => item.id === id)
    if (index >= 0) listed.splice(index, 1)
  }

  /** 卡住下一次写入。 */
  const armDelay = (): WriteGate => {
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    gate = { entered: enter, wait }
    return { entered, release }
  }

  return {
    storage,
    sessions,
    listed,
    createInstance,
    bindings,
    unbound,
    removeSession,
    addSession,
    armDelay,
  }
}

describe("多实例共用一张绑定表", () => {
  it("旧实例卸载时落盘，不会冲掉新实例刚建的绑定", async () => {
    vi.useFakeTimers()
    try {
      const world = createWorld()
      const old = world.createInstance("old")
      const next = world.createInstance("next")

      vi.setSystemTime(new Date(1_000))
      await old.manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
      await old.manager.flush()
      expect(world.bindings()["group:100"]?.sessionID).toBe("old-1")

      // 旧会话没了：新实例只好新建一个会话。
      world.removeSession("old-1")
      vi.setSystemTime(new Date(2_000))
      await next.manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
      await next.manager.flush()
      expect(world.bindings()["group:100"]?.sessionID).toBe("next-1")

      // 旧实例这时才卸载：它手里还是旧绑定，落盘不能把新绑定冲掉。
      await old.manager.flush()
      expect(world.bindings()["group:100"]?.sessionID).toBe("next-1")
    } finally {
      vi.useRealTimers()
    }
  })

  it("旧实例解绑自己的绑定时，不会删掉新实例的绑定", async () => {
    vi.useFakeTimers()
    try {
      const world = createWorld()
      const old = world.createInstance("old")
      const next = world.createInstance("next")

      vi.setSystemTime(new Date(1_000))
      await old.manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
      await old.manager.flush()

      world.removeSession("old-1")
      vi.setSystemTime(new Date(2_000))
      await next.manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
      await next.manager.flush()

      // 旧实例被重置：它解绑的是自己那条，不能顺手动新实例的绑定。
      await old.manager.resetTarget(group(100))
      await old.manager.flush()
      expect(world.bindings()["group:100"]?.sessionID).toBe("next-1")
    } finally {
      vi.useRealTimers()
    }
  })

  it("别的目标写进来的条目不会被冲掉", async () => {
    vi.useFakeTimers()
    try {
      const world = createWorld()
      const one = world.createInstance("one")
      const two = world.createInstance("two")

      vi.setSystemTime(new Date(1_000))
      await one.manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
      await one.manager.flush()

      vi.setSystemTime(new Date(2_000))
      await two.manager.enqueue(group(200), { text: "另一个群", files: [], atMe: false })
      await two.manager.flush()
      expect(world.bindings()["group:200"]?.sessionID).toBe("two-1")

      // 老实例落盘时只维护自己的目标，别的实例写的条目要原样留着。
      await one.manager.flush()
      expect(world.bindings()["group:200"]?.sessionID).toBe("two-1")
      expect(world.bindings()["group:100"]?.sessionID).toBe("one-1")
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("绑定表本身", () => {
  it("显式重置后存储里的绑定被删掉", async () => {
    const world = createWorld()
    const one = world.createInstance("one")

    await one.manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    await one.manager.flush()
    expect(world.bindings()["group:100"]?.sessionID).toBe("one-1")

    await one.manager.resetTarget(group(100))
    await one.manager.flush()
    expect(world.bindings()["group:100"]).toBeUndefined()
  })

  it("旧格式的扁平绑定仍能读，写回时升级成带版本的新格式", async () => {
    const world = createWorld()
    world.sessions.add("legacy-1")
    await world.storage.set("bindings", { "group:100": "legacy-1" })

    const one = world.createInstance("one")
    await one.manager.load()
    await one.manager.flush()

    expect(world.bindings()["group:100"]).toEqual({ sessionID: "legacy-1", at: 0 })
  })

  it("绑定丢了时按会话标记找回上一次的会话", async () => {
    const world = createWorld()
    world.addSession({
      id: "ses_previous",
      directory: "/tmp",
      metadata: { qqTargetKind: "group", qqTargetId: 100 },
    })

    const one = world.createInstance("one")
    expect(await one.manager.ensureSession(group(100))).toBe("ses_previous")
    expect(one.sessionCreate).not.toHaveBeenCalled()
  })

  it("工作目录里没有时按标记全局找回老会话", async () => {
    const world = createWorld()
    // 老版本把会话建在项目目录里，不在工作目录中。
    world.addSession({
      id: "ses_in_project",
      directory: "/project",
      metadata: { qqTargetKind: "group", qqTargetId: 100 },
    })

    const one = world.createInstance("one")
    expect(await one.manager.ensureSession(group(100))).toBe("ses_in_project")
    expect(one.sessionCreate).not.toHaveBeenCalled()
  })

  it("没有标记的老会话按标题找回", async () => {
    const world = createWorld()
    world.addSession({ id: "ses_legacy", directory: "/project", title: "QQ 群 100" })

    const one = world.createInstance("one")
    expect(await one.manager.ensureSession(group(100))).toBe("ses_legacy")
    expect(one.sessionCreate).not.toHaveBeenCalled()
  })

  it("绑定的会话失效后不会再复用它", async () => {
    const world = createWorld()
    // 列表里还留着这条会话，直查已经取不到：按目录查也查不到。
    world.listed.unshift({
      id: "ses_ghost",
      directory: "/project",
      metadata: { qqTargetKind: "group", qqTargetId: 100 },
    })
    await world.storage.set("bindings", { "group:100": { sessionID: "ses_ghost", at: 1_000 } })

    const one = world.createInstance("one")
    // 失效的会话不能又被选回来：否则每条消息都会投递到不存在的会话上。
    expect(await one.manager.ensureSession(group(100))).toBe("one-1")
    expect(one.sessionCreate).toHaveBeenCalledTimes(1)
  })

  it("有标记的会话优先于只对上标题的会话", async () => {
    const world = createWorld()
    world.addSession({ id: "ses_legacy", directory: "/tmp", title: "QQ 群 100" })
    world.addSession({
      id: "ses_marked",
      directory: "/tmp",
      metadata: { qqTargetKind: "group", qqTargetId: 100 },
    })

    const one = world.createInstance("one")
    expect(await one.manager.ensureSession(group(100))).toBe("ses_marked")
  })
})

describe("共享状态的写入", () => {
  afterEach(() => {
    cleanupTempDirs()
  })

  it("失去机器锁后不再写共享状态", async () => {
    const world = createWorld()
    let writable = true
    const one = world.createInstance("one", { canWrite: () => writable })

    await one.manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    await one.manager.flush()
    expect(world.bindings()["group:100"]?.sessionID).toBe("one-1")

    // 机器锁已经易主：共享状态归接管者写，旧实例写出去只会覆盖新状态。
    writable = false
    world.storage.set.mockClear()
    await one.manager.flush()
    expect(world.storage.set).not.toHaveBeenCalled()
  })

  it("两个实例同时落盘时，新绑定不会被旧视图盖掉", async () => {
    const world = createWorld()
    const stale = world.createInstance("stale")
    const fresh = world.createInstance("fresh")

    // 旧实例先绑定一个会话并落盘。
    await stale.manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    await stale.manager.flush()
    expect(world.bindings()["group:100"]?.sessionID).toBe("stale-1")

    // 旧会话没了：新实例会另建会话，绑定版本更新。
    world.removeSession("stale-1")
    // 绑定版本按毫秒计：拉开时间，保证新实例的版本更新。
    await new Promise((resolve) => setTimeout(resolve, 20))

    // 让旧实例的落盘卡在写入上，读-改-写的窗口被撑开。
    const gate = world.armDelay()
    const staleFlush = stale.manager.flush()
    await gate.entered

    // 新实例这时也落盘：没有写锁时它先写完，旧实例的旧视图随后盖掉新绑定；
    // 有写锁时它要等旧实例写完才能落盘。
    await fresh.manager.ensureSession(group(100))
    const freshFlush = fresh.manager.flush()
    const freshDone = await Promise.race([
      freshFlush.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ])
    gate.release()
    await Promise.all([staleFlush, freshFlush])

    expect(world.bindings()["group:100"]?.sessionID).toBe("fresh-1")
    // 写锁存在时，新实例的落盘要排在旧实例之后。
    expect(freshDone).toBe(false)
  })
})

describe("解绑墓碑", () => {
  afterEach(() => {
    cleanupTempDirs()
  })

  it("解绑后墓碑落盘，绑定从共享表里删掉", async () => {
    const world = createWorld()
    const one = world.createInstance("one")

    await one.manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    await one.manager.flush()
    const boundAt = world.bindings()["group:100"]?.at
    expect(boundAt).toBeTypeOf("number")

    await one.manager.resetTarget(group(100))
    await one.manager.flush()

    expect(world.bindings()["group:100"]).toBeUndefined()
    // 墓碑记的是被解绑那条绑定的版本：之后只有更新的绑定能盖过它。
    expect(world.unbound()["group:100"]).toBe(boundAt)
  })

  it("旧实例不会把已经被解开的绑定写回来", async () => {
    const world = createWorld()
    const old = world.createInstance("old")
    const next = world.createInstance("next")

    await old.manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    await old.manager.flush()
    const boundAt = world.bindings()["group:100"]?.at

    // 新实例读到绑定后把它解开：墓碑落盘，绑定从表里删掉。
    await next.manager.load()
    await next.manager.resetTarget(group(100))
    await next.manager.flush()
    expect(world.bindings()["group:100"]).toBeUndefined()
    expect(world.unbound()["group:100"]).toBe(boundAt)

    // 旧实例这时才落盘：它手里还是那条已被解开的绑定。
    await old.manager.flush()
    expect(world.bindings()["group:100"]).toBeUndefined()
    expect(world.unbound()["group:100"]).toBe(boundAt)
  })

  it("解绑后重新绑定会正常落盘并清掉墓碑", async () => {
    const world = createWorld()
    const one = world.createInstance("one")

    await one.manager.enqueue(group(100), { text: "第一条", files: [], atMe: false })
    await one.manager.flush()
    await one.manager.resetTarget(group(100))
    await one.manager.flush()
    expect(world.unbound()["group:100"]).toBeTypeOf("number")

    // 重置会删掉上游会话：下一条消息重新建会话，绑定版本必须越过墓碑。
    world.removeSession("one-1")
    await one.manager.enqueue(group(100), { text: "第二条", files: [], atMe: false })
    await one.manager.flush()

    expect(world.bindings()["group:100"]?.sessionID).toBe("one-2")
    expect(world.unbound()["group:100"]).toBeUndefined()
  })

  it("解绑途中崩溃留下的旧绑定不会在重启后复活", async () => {
    const world = createWorld()
    // 墓碑落盘后、绑定表更新前崩溃：两条记录都还在，版本相同。
    world.sessions.add("ses_old")
    await world.storage.set("bindings", { "group:100": { sessionID: "ses_old", at: 1_000 } })
    await world.storage.set("unbound", { "group:100": 1_000 })

    const one = world.createInstance("one")
    // 被墓碑盖住的绑定不能恢复：否则用户刚删掉的会话又回来了。
    expect(await one.manager.ensureSession(group(100))).toBe("one-1")
    expect(one.sessionCreate).toHaveBeenCalledTimes(1)
  })
})
