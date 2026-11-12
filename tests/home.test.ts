import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultHome, resolveHome } from "../src/home"
import type { Logger } from "../src/logger"

const state = vi.hoisted(() => ({ home: "" }))

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => state.home }
})

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "qq-home-"))
  state.home = join(root, "user")
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe("resolveHome", () => {
  it("creates the workspace under the XDG data directory", async () => {
    const home = await resolveHome(logger)
    expect(home.directory).toBe(join(root, "data", "opencode-qq-bot", "workspace"))
    expect((await stat(home.directory)).isDirectory()).toBe(true)
  })

  it("falls back to ~/.local/share when XDG_DATA_HOME is not absolute", async () => {
    vi.stubEnv("XDG_DATA_HOME", "relative/data")
    const home = await resolveHome(logger)
    expect(home.directory).toBe(join(state.home, ".local", "share", "opencode-qq-bot", "workspace"))
  })

  it("工作目录是固定的：不再接受配置", () => {
    expect(defaultHome()).toBe(join(root, "data", "opencode-qq-bot", "workspace"))
  })
})
