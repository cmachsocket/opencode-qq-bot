import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  findSoulsDirectory,
  resolveSoulPath,
  seedSouls,
  SoulLibrary,
  SoulStore,
  soulsDirectory,
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
  return { home: "/nonexistent", moduleDir: "/nonexistent", ...overrides }
}

describe("findSoulsDirectory", () => {
  it("向上查找 souls 目录", async () => {
    const root = await makeDir("soul-find")
    await mkdir(join(root, "souls"))
    await mkdir(join(root, "src", "session"), { recursive: true })

    expect(findSoulsDirectory(join(root, "src", "session"))).toBe(join(root, "souls"))
  })

  it("找不到时返回 undefined", () => {
    expect(findSoulsDirectory("/")).toBeUndefined()
  })
})

describe("seedSouls", () => {
  it("把随包分发的角色设定复制到工作目录", async () => {
    const pkg = await makeDir("soul-seed-pkg")
    const home = await makeDir("soul-seed-home")
    await mkdir(join(pkg, "souls"))
    await writeFile(join(pkg, "souls", "default.txt"), "默认设定", "utf-8")

    await seedSouls({ home, moduleDir: join(pkg, "src", "session") }, logger)

    expect(await readFile(join(home, "souls", "default.txt"), "utf-8")).toBe("默认设定")
  })

  it("不覆盖工作目录里已有的设定", async () => {
    const pkg = await makeDir("soul-seed-keep-pkg")
    const home = await makeDir("soul-seed-keep-home")
    await mkdir(join(pkg, "souls"))
    await writeFile(join(pkg, "souls", "default.txt"), "包内版本", "utf-8")
    await mkdir(join(home, "souls"))
    await writeFile(join(home, "souls", "default.txt"), "用户改过的版本", "utf-8")

    await seedSouls({ home, moduleDir: pkg }, logger)

    expect(await readFile(join(home, "souls", "default.txt"), "utf-8")).toBe("用户改过的版本")
  })

  it("没有随包设定时也建好目录，供监听器盯住", async () => {
    const home = await makeDir("soul-seed-empty")

    await seedSouls({ home, moduleDir: "/nonexistent" }, logger)

    await expect(readFile(join(soulsDirectory(home), "default.txt"), "utf-8")).rejects.toThrow()
  })
})

describe("resolveSoulPath", () => {
  it("显式路径优先，相对路径按工作目录解析", async () => {
    const home = await makeDir("soul-explicit")
    const file = join(home, "custom.txt")
    await writeFile(file, "设定", "utf-8")

    expect(resolveSoulPath(options({ soulPath: "custom.txt", home }))).toBe(file)
    expect(resolveSoulPath(options({ soulPath: file }))).toBe(file)
  })

  it("显式路径指向目录时取目录下的 soulName", async () => {
    const root = await makeDir("soul-dir")
    await writeFile(join(root, "other.txt"), "设定", "utf-8")

    expect(resolveSoulPath(options({ soulPath: root, soulName: "other.txt" }))).toBe(
      join(root, "other.txt"),
    )
  })

  it("未配置 soulPath 时取工作目录 souls 下的 soulName", async () => {
    const home = await makeDir("soul-default")

    expect(resolveSoulPath(options({ home }))).toBe(join(home, "souls", "default.txt"))
    expect(resolveSoulPath(options({ home, soulName: "白羽桃.txt" }))).toBe(
      join(home, "souls", "白羽桃.txt"),
    )
  })

  it("文件不存在时给出预期路径，便于稍后补齐", async () => {
    const home = await makeDir("soul-expected")

    expect(resolveSoulPath(options({ home, soulName: "later.txt" }))).toBe(
      join(home, "souls", "later.txt"),
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
    const home = await makeDir("soul-late")
    await mkdir(soulsDirectory(home))

    const store = new SoulStore(options({ home, soulName: "later.txt" }), logger)
    await store.load()
    expect(store.text).toBe("")

    await writeFile(join(soulsDirectory(home), "later.txt"), "迟到的设定", "utf-8")
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

  it("相对路径按工作目录解析", async () => {
    const home = await makeDir("soul-library-relative")
    await mkdir(soulsDirectory(home))
    await writeFile(join(soulsDirectory(home), "rel.txt"), "相对设定", "utf-8")

    const library = new SoulLibrary(options({ home }), logger)
    const store = await library.at(join("souls", "rel.txt"))
    expect(store.path).toBe(join(soulsDirectory(home), "rel.txt"))
    expect(store.text).toBe("相对设定")

    library.dispose()
  })

  it("只写名字时取工作目录 souls/ 下的文件", async () => {
    const home = await makeDir("soul-library-name")
    await mkdir(soulsDirectory(home))
    await writeFile(join(soulsDirectory(home), "named.txt"), "按名字取的设定", "utf-8")

    const library = new SoulLibrary(options({ home }), logger)
    const store = await library.at(undefined, "named.txt")
    expect(store.path).toBe(join(soulsDirectory(home), "named.txt"))
    expect(store.text).toBe("按名字取的设定")

    library.dispose()
  })

  it("角色设定正文不带 QQ 守则，守则只在 prompt 里", async () => {
    const home = await makeDir("soul-persona")
    await mkdir(soulsDirectory(home))
    await writeFile(join(soulsDirectory(home), "default.txt"), "你是白羽桃", "utf-8")

    const library = new SoulLibrary(options({ home }), logger)
    const store = await library.at(undefined)
    expect(store.text).toBe("你是白羽桃")
    expect(store.text).not.toContain("qq_send_message")
    expect(store.prompt).toContain("qq_send_message")

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
