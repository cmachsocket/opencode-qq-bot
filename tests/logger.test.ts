import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { closeLogger, createLogger, defaultLogDir } from "../src/logger"

/** 临时目录列表，测试结束后清掉。 */
const dirs: string[] = []

/** 建一个临时日志目录。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qq-bot-log-"))
  dirs.push(dir)
  return dir
}

/** 目录里的日志文件（审计文件不算）。 */
function logFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.startsWith("qq-bot-"))
    .sort()
}

/** 目录里所有日志文件的内容。 */
function readLogs(dir: string): string {
  return logFiles(dir)
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("")
}

/** 抓控制台输出。 */
function captureConsole(): { text: () => string; restore: () => void } {
  const chunks: string[] = []
  const target = console as unknown as {
    _stdout?: { write?: (chunk: string) => boolean }
    _stderr?: { write?: (chunk: string) => boolean }
  }
  const originalOut = target._stdout?.write
  const originalErr = target._stderr?.write
  const originalLog = console.log
  const originalError = console.error
  const record = (chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  }
  if (target._stdout) target._stdout.write = record as typeof target._stdout.write
  if (target._stderr) target._stderr.write = record as typeof target._stderr.write
  console.log = (...args: unknown[]) => {
    chunks.push(args.map((arg) => String(arg)).join(" "))
  }
  console.error = (...args: unknown[]) => {
    chunks.push(args.map((arg) => String(arg)).join(" "))
  }
  return {
    text: () => chunks.join(""),
    restore: () => {
      if (target._stdout && originalOut) target._stdout.write = originalOut
      if (target._stderr && originalErr) target._stderr.write = originalErr
      console.log = originalLog
      console.error = originalError
    },
  }
}

afterEach(async () => {
  await closeLogger()
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("日志器", () => {
  it("低于级别的日志不落盘", async () => {
    const dir = tempDir()
    const logger = createLogger("[test]", { level: "warn", dir })
    logger.debug("debug 行")
    logger.info("info 行")
    logger.warn("warn 行")
    logger.error("error 行")
    await closeLogger()
    const content = readLogs(dir)
    expect(content).not.toContain("debug 行")
    expect(content).not.toContain("info 行")
    expect(content).toContain("warn 行")
    expect(content).toContain("error 行")
  })

  it("控制台输出保持人类可读格式", async () => {
    const capture = captureConsole()
    const logger = createLogger("[qq-bot]", { file: false })
    logger.info("你好", { count: 2 })
    await closeLogger()
    capture.restore()
    expect(capture.text()).toMatch(
      /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] INFO \[qq-bot\] 你好/,
    )
    expect(capture.text()).toContain("count: 2")
  })

  it("只关闭指定的日志器", async () => {
    const dirA = tempDir()
    const dirB = tempDir()
    const a = createLogger("[a]", { dir: dirA })
    const b = createLogger("[b]", { dir: dirB })
    a.info("a1")
    b.info("b1")
    await closeLogger(a)
    b.info("b2")
    await closeLogger(b)
    expect(readLogs(dirA)).toContain("a1")
    expect(readLogs(dirA)).not.toContain("b1")
    expect(readLogs(dirB)).toContain("b1")
    expect(readLogs(dirB)).toContain("b2")
  })

  it("日志文件一行一条 JSON", async () => {
    const dir = tempDir()
    const logger = createLogger("[test]", { dir })
    logger.info("第一条")
    logger.warn("第二条", { a: 1 })
    await closeLogger()
    const content = readLogs(dir).trim()
    expect(content.length).toBeGreaterThan(0)
    const lines = content.split("\n")
    expect(lines.length).toBe(2)
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(parsed[0]?.level).toBe("info")
    expect(parsed[0]?.message).toBe("第一条")
    expect(parsed[1]?.level).toBe("warn")
    expect(parsed[1]?.meta).toEqual([{ a: 1 }])
  })

  it("message、meta 与 Error 栈里的凭证都会打码", async () => {
    const dir = tempDir()
    const logger = createLogger("[test]", { dir })
    logger.info("带上 ghp_0123456789abcdefghijklmnopqrstuvwxyz")
    logger.info("带上 AKIAIOSFODNN7EXAMPLE", { key: "AKIAIOSFODNN7EXAMPLE" })
    logger.error("出错了", new Error("token=abcdefghijklmnop"))
    await closeLogger()
    const content = readLogs(dir)
    expect(content).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyz")
    expect(content).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(content).not.toContain("abcdefghijklmnop")
    expect(content).toContain("[REDACTED:")
  })

  it("已知凭证明文也会打码", async () => {
    const dir = tempDir()
    const logger = createLogger("[test]", {
      dir,
      knownSecrets: ["s3cret-value-that-is-long"],
    })
    logger.info("出现 s3cret-value-that-is-long")
    await closeLogger()
    const content = readLogs(dir)
    expect(content).not.toContain("s3cret-value-that-is-long")
    expect(content).toContain("[REDACTED:")
  })

  it("普通聊天内容不会被误伤", async () => {
    const dir = tempDir()
    const logger = createLogger("[test]", { dir })
    logger.info("大家好，今天群里 1234567890 号在讨论天气")
    logger.info(
      "邮箱 a@example.com，链接 https://example.com/x，编号 123e4567-e89b-12d3-a456-426614174000",
    )
    logger.info("手机 13800138000")
    await closeLogger()
    const content = readLogs(dir)
    expect(content).toContain("大家好，今天群里 1234567890 号在讨论天气")
    expect(content).toContain("a@example.com")
    expect(content).toContain("https://example.com/x")
    expect(content).toContain("123e4567-e89b-12d3-a456-426614174000")
    expect(content).toContain("13800138000")
    expect(content).not.toContain("[REDACTED")
  })

  it("日志目录不存在时自动创建", async () => {
    const base = tempDir()
    const dir = join(base, "nested", "logs")
    const logger = createLogger("[test]", { dir })
    logger.info("目录测试")
    await closeLogger()
    expect(existsSync(dir)).toBe(true)
    expect(logFiles(dir).length).toBe(1)
  })

  it("文件名带日期，超过大小上限会轮转并按份数保留", async () => {
    const dir = tempDir()
    const logger = createLogger("[test]", { dir, maxSize: "1k", maxFiles: 2 })
    // 轮转要等文件真正落盘才会清理旧文件，所以这里一行一行地写。
    for (let i = 0; i < 30; i++) {
      logger.info(`第 ${i} 行`, "x".repeat(200))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await closeLogger()
    const files = logFiles(dir)
    expect(files.length).toBe(2)
    expect(files[0]).toMatch(/^qq-bot-\d{4}-\d{2}-\d{2}\.log/)
  })

  it("默认日志目录跟着 XDG_STATE_HOME 走", () => {
    const original = process.env.XDG_STATE_HOME
    try {
      process.env.XDG_STATE_HOME = "/tmp/xdg-state"
      expect(defaultLogDir()).toBe(join("/tmp/xdg-state", "opencode-qq-bot", "logs"))
      process.env.XDG_STATE_HOME = "relative/state"
      expect(defaultLogDir()).toContain(join(".local", "state", "opencode-qq-bot", "logs"))
      delete process.env.XDG_STATE_HOME
      expect(defaultLogDir()).toContain(join(".local", "state", "opencode-qq-bot", "logs"))
    } finally {
      if (original === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = original
    }
  })
})
