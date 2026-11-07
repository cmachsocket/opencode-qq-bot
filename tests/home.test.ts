import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveHome } from "../src/home"
import type { Logger } from "../src/logger"

const state = vi.hoisted(() => ({ home: "" }))

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => state.home }
})

const warn = vi.fn()
const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn,
  error: () => {},
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "qq-home-"))
  state.home = join(root, "user")
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"))
  warn.mockClear()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe("resolveHome", () => {
  it("creates the workspace under the XDG data directory by default", async () => {
    const home = await resolveHome(undefined, logger)
    expect(home.directory).toBe(join(root, "data", "opencode-qq-bot", "workspace"))
    expect((await stat(home.directory)).isDirectory()).toBe(true)
  })

  it("falls back to ~/.local/share when XDG_DATA_HOME is not absolute", async () => {
    vi.stubEnv("XDG_DATA_HOME", "relative/data")
    const home = await resolveHome(undefined, logger)
    expect(home.directory).toBe(join(state.home, ".local", "share", "opencode-qq-bot", "workspace"))
  })

  it("prefers the configured directory and creates it", async () => {
    const target = join(root, "custom", "workspace")
    await expect(resolveHome(target, logger)).resolves.toEqual({ directory: target })
    expect((await stat(target)).isDirectory()).toBe(true)
  })

  it("expands a leading ~", async () => {
    await expect(resolveHome("~/bot", logger)).resolves.toEqual({
      directory: join(state.home, "bot"),
    })
    await expect(resolveHome("~", logger)).resolves.toEqual({ directory: state.home })
  })

  it("warns and falls back for a relative path", async () => {
    const home = await resolveHome("relative/path", logger)
    expect(home.directory).toBe(join(root, "data", "opencode-qq-bot", "workspace"))
    expect(warn).toHaveBeenCalled()
  })
})
