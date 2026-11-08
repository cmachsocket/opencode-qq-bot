import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultMediaDir, OutboundMedia } from "../src/media-path"

/** 建一个临时工作目录，里面放一个图片文件。 */
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qq-bot-media-"))
  await writeFile(join(dir, "a.png"), "png")
  return dir
}

describe("defaultMediaDir", () => {
  it("follows XDG_STATE_HOME", () => {
    const previous = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = "/tmp/state"
    try {
      expect(defaultMediaDir()).toBe("/tmp/state/opencode-qq-bot/media")
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
    }
  })

  it("falls back to ~/.local/state", () => {
    const previous = process.env.XDG_STATE_HOME
    delete process.env.XDG_STATE_HOME
    try {
      expect(defaultMediaDir()).toMatch(/\.local\/state\/opencode-qq-bot\/media$/)
    } finally {
      if (previous !== undefined) process.env.XDG_STATE_HOME = previous
    }
  })
})

describe("OutboundMedia", () => {
  it("allows a file inside the workspace", async () => {
    const dir = await workspace()
    const media = new OutboundMedia({ workspace: dir, allowedDirs: [dir] })
    const plan = await media.check(join(dir, "a.png"))
    expect(plan.kind).toBe("local")
    expect(media.materialize(plan)).toBe(join(dir, "a.png"))
  })

  it("resolves relative paths against the workspace", async () => {
    const dir = await workspace()
    const media = new OutboundMedia({ workspace: dir, allowedDirs: [dir] })
    const plan = await media.check("a.png")
    expect(plan.kind === "local" && plan.path).toBe(join(dir, "a.png"))
  })

  it("refuses a file outside the allowed directories", async () => {
    const dir = await workspace()
    const media = new OutboundMedia({ workspace: dir, allowedDirs: [dir] })
    await expect(media.check("/etc/hostname")).rejects.toThrow("不在允许的目录内")
  })

  it("refuses a missing file", async () => {
    const dir = await workspace()
    const media = new OutboundMedia({ workspace: dir, allowedDirs: [dir] })
    await expect(media.check(join(dir, "nope.png"))).rejects.toThrow("不存在")
  })

  it("refuses a symlink pointing outside the allowed directories", async () => {
    const dir = await workspace()
    const outside = await workspace()
    await writeFile(join(outside, "secret.png"), "secret")
    await symlink(join(outside, "secret.png"), join(dir, "link.png"))
    const media = new OutboundMedia({ workspace: dir, allowedDirs: [dir] })
    await expect(media.check(join(dir, "link.png"))).rejects.toThrow("不在允许的目录内")
  })

  it("compares directories by boundary, not by prefix", async () => {
    const base = await workspace()
    const sibling = `${base}-secret`
    await mkdir(sibling, { recursive: true })
    await writeFile(join(sibling, "s.png"), "s")
    const media = new OutboundMedia({ workspace: base, allowedDirs: [base] })
    await expect(media.check(join(sibling, "s.png"))).rejects.toThrow("不在允许的目录内")
  })

  it("allows a directory listed in the policy", async () => {
    const dir = await workspace()
    const other = await workspace()
    const media = new OutboundMedia({ workspace: dir, allowedDirs: [dir, other] })
    const plan = await media.check(join(other, "a.png"))
    expect(plan.kind === "local" && plan.path).toBe(join(other, "a.png"))
  })

  it("keeps a public address as is", async () => {
    const dir = await workspace()
    const media = new OutboundMedia({ workspace: dir, allowedDirs: [dir] })
    const plan = await media.check("https://93.184.216.34/a.png")
    expect(plan.kind).toBe("remote")
    expect(media.materialize(plan)).toBe("https://93.184.216.34/a.png")
  })

  it("refuses an address pointing at the loopback interface", async () => {
    const dir = await workspace()
    const media = new OutboundMedia({ workspace: dir, allowedDirs: [dir] })
    await expect(media.check("http://127.0.0.1/a.png")).rejects.toThrow("指向内网")
  })

  it("refuses an address pointing at a private network", async () => {
    const dir = await workspace()
    const media = new OutboundMedia({ workspace: dir, allowedDirs: [dir] })
    await expect(media.check("http://192.168.1.10/a.png")).rejects.toThrow("指向内网")
  })

  it("refuses a hostname that resolves to the loopback interface", async () => {
    const dir = await workspace()
    const media = new OutboundMedia({ workspace: dir, allowedDirs: [dir] })
    await expect(media.check("http://localhost/a.png")).rejects.toThrow("指向内网")
  })

  it("refuses a port outside the allow list", async () => {
    const dir = await workspace()
    const media = new OutboundMedia({ workspace: dir, allowedDirs: [dir] })
    await expect(media.check("https://93.184.216.34:9999/a.png")).rejects.toThrow("端口")
    const allowed = await media.check("https://93.184.216.34:8443/a.png")
    expect(allowed.kind).toBe("remote")
  })

  it("refuses unsupported schemes", async () => {
    const dir = await workspace()
    const media = new OutboundMedia({ workspace: dir, allowedDirs: [dir] })
    await expect(media.check("ftp://example.com/a.png")).rejects.toThrow("不支持的媒体地址")
  })
})
