import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ConfigController } from "../src/config/live"
import { ConfigMissingError, ConfigStore } from "../src/config/store"
import { DEFAULT_CONFIG } from "../src/config"
import type { Logger } from "../src/logger"

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

let root: string
let path: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "qq-config-"))
  path = join(root, "config.json")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("ConfigStore", () => {
  it("文件不存在时明确报错，不静默用默认值", async () => {
    const store = new ConfigStore(path, logger)
    await expect(store.read()).rejects.toBeInstanceOf(ConfigMissingError)
    await expect(store.read()).rejects.toThrow(/配置文件不存在/)
  })

  it("写入后能读回，文件权限是 0600", async () => {
    const store = new ConfigStore(path, logger)
    await store.write({ napcat: { url: "ws://127.0.0.1:3001" } })
    expect(await store.read()).toEqual({ napcat: { url: "ws://127.0.0.1:3001" } })
    const info = await stat(path)
    expect(info.mode & 0o777).toBe(0o600)
  })

  it("目录按 0700 创建", async () => {
    const nested = join(root, "deep", "config.json")
    const store = new ConfigStore(nested, logger)
    await store.write({ napcat: { url: "ws://127.0.0.1:3001" } })
    const info = await stat(join(root, "deep"))
    expect(info.mode & 0o777).toBe(0o700)
  })

  it("写之前留一份备份", async () => {
    const store = new ConfigStore(path, logger)
    await store.write({ napcat: { url: "ws://127.0.0.1:3001" } })
    await store.write({ napcat: { url: "ws://127.0.0.1:4001" } })
    const backup = JSON.parse(await readFile(store.backupPath, "utf8")) as {
      napcat: { url: string }
    }
    expect(backup.napcat.url).toBe("ws://127.0.0.1:3001")
  })

  it("内容不是 JSON 对象时报错", async () => {
    await writeFile(path, "[1,2]", "utf8")
    const store = new ConfigStore(path, logger)
    await expect(store.read()).rejects.toThrow(/解析失败/)
  })

  it("补丁只改指定的路径", async () => {
    const store = new ConfigStore(path, logger)
    await store.write({
      napcat: { url: "ws://127.0.0.1:3001" },
      access: { allow: { groups: [1] } },
    })
    const patched = await store.patch({ "access.allow.groups": [2, 3] })
    expect(patched).toEqual({
      napcat: { url: "ws://127.0.0.1:3001" },
      access: { allow: { groups: [2, 3] } },
    })
  })

  it("补丁里的 null 表示删掉这个键", async () => {
    const store = new ConfigStore(path, logger)
    await store.write({
      napcat: { url: "ws://127.0.0.1:3001" },
      access: { allow: { groups: [1] } },
    })
    const patched = await store.patch({ "access.allow.groups": null })
    expect(patched.access).toEqual({ allow: {} })
  })

  it("补丁会补齐缺失的中间对象", async () => {
    const store = new ConfigStore(path, logger)
    await store.write({ napcat: { url: "ws://127.0.0.1:3001" } })
    const patched = await store.patch({ "access.allow.groups": [7] })
    expect(patched.access).toEqual({ allow: { groups: [7] } })
  })
})

describe("ConfigController", () => {
  it("加载配置文件并解析成生效配置", async () => {
    const store = new ConfigStore(path, logger)
    await store.write({ napcat: { url: "ws://127.0.0.1:3001" } })
    const controller = new ConfigController({ store, logger })
    const config = await controller.load()
    expect(config.napcat.url).toBe("ws://127.0.0.1:3001")
    expect(controller.current).toBe(config)
  })

  it("应用补丁后落盘，并标出要重启的字段", async () => {
    const store = new ConfigStore(path, logger)
    await store.write({ napcat: { url: "ws://127.0.0.1:3001" } })
    const controller = new ConfigController({ store, logger })
    await controller.load()
    const result = await controller.applyPatch({
      "rateLimit.maxPerMinute": 3,
      "napcat.url": "ws://127.0.0.1:4001",
    })
    expect(result.restartRequired).toEqual(["napcat.url"])
    const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    expect(saved).toMatchObject({
      napcat: { url: "ws://127.0.0.1:4001" },
      rateLimit: { maxPerMinute: 3 },
    })
  })

  it("热字段立刻生效，冷字段要重启", async () => {
    const store = new ConfigStore(path, logger)
    await store.write({ napcat: { url: "ws://127.0.0.1:3001" } })
    const controller = new ConfigController({ store, logger })
    const config = await controller.load()
    await controller.applyPatch({
      "rateLimit.maxPerMinute": 3,
      "napcat.url": "ws://127.0.0.1:4001",
    })
    expect(config.rateLimit.maxPerMinute).toBe(3)
    expect(config.napcat.url).toBe("ws://127.0.0.1:3001")
  })

  it("外部改动配置文件会热更新", async () => {
    const store = new ConfigStore(path, logger)
    await store.write({ napcat: { url: "ws://127.0.0.1:3001" } })
    const controller = new ConfigController({ store, logger })
    const config = await controller.load()
    const changes: number[] = []
    controller.onChange((next) => changes.push(next.rateLimit.maxPerMinute))
    await controller.startWatching()
    await writeFile(
      path,
      JSON.stringify({ napcat: { url: "ws://127.0.0.1:3001" }, rateLimit: { maxPerMinute: 9 } }),
      "utf8",
    )
    await new Promise((resolve) => setTimeout(resolve, 800))
    controller.stop()
    expect(config.rateLimit.maxPerMinute).toBe(9)
    expect(changes).toContain(9)
  })

  it("外部改成非法内容时保留上一份配置", async () => {
    const store = new ConfigStore(path, logger)
    await store.write({ napcat: { url: "ws://127.0.0.1:3001" } })
    const controller = new ConfigController({ store, logger })
    const config = await controller.load()
    const warnings: string[] = []
    const watching = new ConfigController({
      store,
      logger,
      warn: (message) => warnings.push(message),
    })
    await watching.load()
    await watching.startWatching()
    await writeFile(path, JSON.stringify({ rateLimit: { maxPerMinute: 9 } }), "utf8")
    await new Promise((resolve) => setTimeout(resolve, 800))
    watching.stop()
    expect(config.rateLimit.maxPerMinute).toBe(DEFAULT_CONFIG.rateLimit.maxPerMinute)
  })
})
