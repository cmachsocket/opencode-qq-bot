import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  findSoulFile,
  resolveSoulPath,
  SoulLibrary,
  SoulStore,
  type SoulOptions,
} from "../src/session/soul"
import type { Logger } from "../src/logger"

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const temporaries: string[] = []

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`))
  temporaries.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("等待超时")
}

function options(overrides: Partial<SoulOptions> = {}): SoulOptions {
  return { moduleDir: "/nonexistent", cwd: "/nonexistent", ...overrides }
}

describe("findSoulFile", () => {
  it("向上查找 souls 目录里的指定文件", async () => {
    const root = await makeDir("soul-find")
    await mkdir(join(root, "souls"))
    await writeFile(join(root, "souls", "白羽桃.txt"), "设定", "utf-8")
    await mkdir(join(root, "src", "session"), { recursive: true })

    expect(findSoulFile(join(root, "src", "session"), "白羽桃.txt")).toBe(
      join(root, "souls", "白羽桃.txt"),
    )
  })

  it("找不到时返回 undefined", () => {
    expect(findSoulFile("/")).toBeUndefined()
  })
})

describe("resolveSoulPath", () => {
  it("显式路径优先，相对路径按 cwd 解析", async () => {
    const root = await makeDir("soul-explicit")
    const file = join(root, "custom.txt")
    await writeFile(file, "设定", "utf-8")

    expect(resolveSoulPath(options({ soulPath: "custom.txt", cwd: root }))).toBe(file)
    expect(resolveSoulPath(options({ soulPath: file }))).toBe(file)
  })

  it("显式路径指向目录时取目录下的 soulName", async () => {
    const root = await makeDir("soul-dir")
    await writeFile(join(root, "other.txt"), "设定", "utf-8")

    expect(resolveSoulPath(options({ soulPath: root, soulName: "other.txt" }))).toBe(
      join(root, "other.txt"),
    )
  })

  it("未配置 soulPath 时按 soulName 查找包内 souls 目录", async () => {
    const root = await makeDir("soul-default")
    await mkdir(join(root, "souls"))
    await writeFile(join(root, "souls", "default.txt"), "默认设定", "utf-8")

    expect(resolveSoulPath(options({ moduleDir: root }))).toBe(join(root, "souls", "default.txt"))
  })

  it("文件不存在时给出预期路径，便于稍后补齐", async () => {
    const root = await makeDir("soul-expected")
    await mkdir(join(root, "souls"))

    expect(resolveSoulPath(options({ moduleDir: root, soulName: "later.txt" }))).toBe(
      join(root, "souls", "later.txt"),
    )
  })
})

describe("SoulStore", () => {
  it("读取角色设定并组装提示词", async () => {
    const root = await makeDir("soul-store")
    const file = join(root, "soul.txt")
    await writeFile(file, "你是白羽桃", "utf-8")

    const store = new SoulStore(options({ soulPath: file }), logger)
    await store.load()

    expect(store.path).toBe(file)
    expect(store.text).toBe("你是白羽桃")
    expect(store.prompt).toContain("你是白羽桃")
    expect(store.prompt).toContain("qq_send_message")
    store.dispose()
  })

  it("文件改动后提示词热更新", async () => {
    const root = await makeDir("soul-reload")
    const file = join(root, "soul.txt")
    await writeFile(file, "第一版", "utf-8")

    const store = new SoulStore(options({ soulPath: file }), logger)
    await store.load()
    expect(store.prompt).toContain("第一版")

    await writeFile(file, "第二版", "utf-8")
    await waitFor(() => store.text === "第二版")
    expect(store.prompt).toContain("第二版")
    store.dispose()
  })

  it("文件稍后出现时也能加载", async () => {
    const root = await makeDir("soul-late")
    await mkdir(join(root, "souls"))

    const store = new SoulStore(options({ moduleDir: root, soulName: "later.txt" }), logger)
    await store.load()
    expect(store.text).toBe("")

    await writeFile(join(root, "souls", "later.txt"), "迟到的设定", "utf-8")
    await waitFor(() => store.text === "迟到的设定")
    store.dispose()
  })

  it("找不到角色设定时给出空提示词", async () => {
    const store = new SoulStore(options({ soulPath: "/nonexistent/soul.txt" }), logger)
    await store.load()

    expect(store.text).toBe("")
    expect(store.prompt).toContain("qq_send_message")
    store.dispose()
  })
})

describe("SoulLibrary", () => {
  it("默认档与指定路径各自生效", async () => {
    const root = await makeDir("soul-library")
    const custom = join(root, "custom.txt")
    await writeFile(custom, "你是审阅者", "utf-8")

    const library = new SoulLibrary(options({ soulPath: custom }), logger)
    const fallback = await library.loadDefault()
    expect(fallback.text).toBe("你是审阅者")

    const other = join(root, "other.txt")
    await writeFile(other, "你是作者", "utf-8")
    const store = await library.at(other)
    expect(store.text).toBe("你是作者")
    expect(store.prompt).toContain("你是作者")

    library.dispose()
  })

  it("路径为空时用默认档，同一路径只加载一次", async () => {
    const root = await makeDir("soul-library-cache")
    const custom = join(root, "custom.txt")
    await writeFile(custom, "默认设定", "utf-8")

    const library = new SoulLibrary(options({ soulPath: custom }), logger)
    const first = await library.at(undefined)
    const second = await library.at(custom)
    expect(second).toBe(first)
    expect(first.text).toBe("默认设定")

    library.dispose()
  })

  it("相对路径按 cwd 解析", async () => {
    const root = await makeDir("soul-library-relative")
    await writeFile(join(root, "rel.txt"), "相对设定", "utf-8")

    const library = new SoulLibrary(options({ cwd: root }), logger)
    const store = await library.at("rel.txt")
    expect(store.path).toBe(join(root, "rel.txt"))
    expect(store.text).toBe("相对设定")

    library.dispose()
  })

  it("文件不存在时给出空提示词", async () => {
    const library = new SoulLibrary(options({ soulPath: "/nonexistent/soul.txt" }), logger)
    const store = await library.at("/nonexistent/soul.txt")
    expect(store.text).toBe("")
    expect(store.prompt).toContain("qq_send_message")

    library.dispose()
  })
})
