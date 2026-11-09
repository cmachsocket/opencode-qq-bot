import { describe, expect, it } from "vitest"
import { mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Tracer } from "../src/trace"
import type { Logger } from "../src/logger"

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

async function createTracer(options: Partial<ConstructorParameters<typeof Tracer>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "qq-bot-trace-"))
  const tracer = new Tracer({ dir, logger, ...options })
  return { tracer, dir }
}

describe("Tracer", () => {
  it("默认不记录", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qq-bot-trace-"))
    const tracer = new Tracer({ enabled: false, dir })
    expect(tracer.active).toBe(false)
    await tracer.record("event_received", "trace-1")
    expect(tracer.spans()).toEqual([])
  })

  it("记下的节点带同一个 trace id", async () => {
    const { tracer } = await createTracer()
    const traceId = tracer.startTrace()
    await tracer.record("event_received", traceId, { message_id: "1" }, "group:100")
    await tracer.record("agent_start", traceId, {}, "group:100")
    await tracer.record("handler_start", traceId)
    await tracer.record("response_sent", traceId, { chars: 10 })
    const spans = tracer.spans()
    expect(spans.map((span) => span.name)).toEqual([
      "event_received",
      "agent_start",
      "handler_start",
      "response_sent",
    ])
    expect(spans.every((span) => span.traceId === traceId)).toBe(true)
    expect(spans[0]?.target).toBe("group:100")
    expect(spans[0]?.attributes).toEqual({ message_id: "1" })
    expect(spans[3]?.attributes).toEqual({ chars: 10 })
  })

  it("每个节点有自己的 span id", async () => {
    const { tracer } = await createTracer()
    const traceId = tracer.startTrace()
    await tracer.record("event_received", traceId)
    await tracer.record("agent_start", traceId)
    const spans = tracer.spans()
    expect(spans[0]?.spanId).not.toBe(spans[1]?.spanId)
  })

  it("节点写进当天的追踪文件", async () => {
    const { tracer, dir } = await createTracer({ now: () => Date.parse("2026-02-03T04:05:06Z") })
    await tracer.record("event_received", "trace-1", { message_id: "7" })
    const files = await readdir(dir)
    expect(files).toContain("qq-bot-traces-2026-02-03.jsonl")
    const path = join(dir, "qq-bot-traces-2026-02-03.jsonl")
    const content = await readFile(path, "utf8")
    const line = JSON.parse(content.trim()) as { traceId: string; name: string }
    expect(line.traceId).toBe("trace-1")
    expect(line.name).toBe("event_received")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it("内存里只保留最近的记录", async () => {
    const { tracer } = await createTracer({ memorySpans: 2 })
    const traceId = tracer.startTrace()
    await tracer.record("event_received", traceId)
    await tracer.record("agent_start", traceId)
    await tracer.record("handler_start", traceId)
    expect(tracer.spans()).toHaveLength(2)
    expect(tracer.spans()[1]?.name).toBe("handler_start")
  })

  it("超过保留天数的文件会被清掉", async () => {
    const { tracer, dir } = await createTracer({
      retentionDays: 7,
      now: () => Date.parse("2026-02-10T00:00:00Z"),
    })
    const old = join(dir, "qq-bot-traces-2026-02-01.jsonl")
    await writeFile(old, "{}\n", "utf8")
    const oldTime = new Date(Date.parse("2026-02-01T00:00:00Z"))
    await utimes(old, oldTime, oldTime)
    const fresh = join(dir, "qq-bot-traces-2026-02-09.jsonl")
    await writeFile(fresh, "{}\n", "utf8")
    await tracer.prune()
    const files = await readdir(dir)
    expect(files).not.toContain("qq-bot-traces-2026-02-01.jsonl")
    expect(files).toContain("qq-bot-traces-2026-02-09.jsonl")
  })

  it("容量超了先删旧文件", async () => {
    const { tracer, dir } = await createTracer({
      maxSizeMb: 1,
      now: () => Date.parse("2026-02-10T00:00:00Z"),
    })
    // 造一个超过上限的大文件。
    await writeFile(
      join(dir, "qq-bot-traces-2026-02-01.jsonl"),
      "x".repeat(2 * 1024 * 1024),
      "utf8",
    )
    await writeFile(join(dir, "qq-bot-traces-2026-02-09.jsonl"), "{}\n", "utf8")
    await tracer.prune()
    const files = await readdir(dir)
    expect(files).not.toContain("qq-bot-traces-2026-02-01.jsonl")
    expect(files).toContain("qq-bot-traces-2026-02-09.jsonl")
  })

  it("写满又清不出空间时丢弃新的追踪记录", async () => {
    const warnings: string[] = []
    const dir = await mkdtemp(join(tmpdir(), "qq-bot-trace-"))
    const tracer = new Tracer({
      dir,
      maxSizeMb: 1,
      logger: { ...logger, warn: (message: string) => warnings.push(message) },
    })
    const internals = tracer as unknown as { bytes: number; prune: () => Promise<void> }
    internals.prune = async () => {}
    internals.bytes = 2 * 1024 * 1024
    await tracer.record("event_received", "trace-1")
    expect(warnings).toContain("调用链追踪已写满，丢弃新的追踪记录")
    expect(await readdir(dir)).toEqual([])
  })

  it("prune 不会重复扣减已过期的文件", async () => {
    const { tracer, dir } = await createTracer({
      maxSizeMb: 1,
      retentionDays: 7,
      now: () => Date.parse("2026-02-10T00:00:00Z"),
    })
    const expired = join(dir, "qq-bot-traces-2026-02-01.jsonl")
    await writeFile(expired, "x", "utf8")
    const oldTime = new Date(Date.parse("2026-02-01T00:00:00Z"))
    await utimes(expired, oldTime, oldTime)
    await writeFile(
      join(dir, "qq-bot-traces-2026-02-09.jsonl"),
      "x".repeat(2 * 1024 * 1024),
      "utf8",
    )
    await tracer.prune()
    expect((tracer as unknown as { bytes: number }).bytes).toBe(0)
  })

  it("写文件失败时只告警，不抛错", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qq-bot-trace-"))
    const warnings: string[] = []
    const tracer = new Tracer({
      dir: join(dir, "not-a-dir"),
      logger: { ...logger, warn: (message: string) => warnings.push(message) },
    })
    // 目录位置被一个文件占住，写不进去。
    await writeFile(join(dir, "not-a-dir"), "x", "utf8")
    await expect(tracer.record("event_received", "trace-1")).resolves.toBeUndefined()
    expect(warnings.length).toBeGreaterThan(0)
    // 内存里仍然记下了这条节点。
    expect(tracer.spans()).toHaveLength(1)
  })
})
