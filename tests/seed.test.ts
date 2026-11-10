import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { seedFile } from "../src/seed"
import type { Logger } from "../src/logger"

const warnings: string[] = []

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (message) => warnings.push(message),
  error: () => {},
}

const temporaries: string[] = []

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`))
  temporaries.push(dir)
  return dir
}

afterEach(async () => {
  warnings.length = 0
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("seedFile", () => {
  it("把模板复制到目标位置，父目录一并建好", async () => {
    const root = await makeDir("seed-copy")
    const source = join(root, "tool-profiles.example.json")
    const destination = join(root, "home", "tool-profiles.json")
    await writeFile(source, '{"defaultProfile":"chat"}\n', "utf-8")

    expect(await seedFile(source, destination, logger)).toBe(true)

    expect(await readFile(destination, "utf-8")).toBe('{"defaultProfile":"chat"}\n')
  })

  it("目标已存在时保留原内容", async () => {
    const root = await makeDir("seed-keep")
    const source = join(root, "chat-overrides.example.json")
    const destination = join(root, "chat-overrides.json")
    await writeFile(source, '{"chats":{"group:1":{}}}\n', "utf-8")
    await writeFile(destination, '{"chats":{}}\n', "utf-8")

    expect(await seedFile(source, destination, logger)).toBe(false)

    expect(await readFile(destination, "utf-8")).toBe('{"chats":{}}\n')
    expect(warnings).toEqual([])
  })

  it("模板缺失时只告警，不抛错", async () => {
    const root = await makeDir("seed-missing")

    expect(await seedFile(join(root, "nope.json"), join(root, "home", "target.json"), logger)).toBe(
      false,
    )

    expect(warnings).toHaveLength(1)
  })
})
