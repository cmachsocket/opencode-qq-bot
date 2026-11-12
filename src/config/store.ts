import { mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import chokidar, { type FSWatcher } from "chokidar"
import writeFileAtomic from "write-file-atomic"
import type { Logger } from "../logger"

/**
 * `config.json` 的读写。
 *
 * 写入用 `write-file-atomic`：临时文件 + fsync + rename，中途失败不会留下半截文件；
 * 保留一份 `.bak`，写坏了还能翻回去。
 */

/** 配置文件不存在。 */
export class ConfigMissingError extends Error {
  constructor(path: string) {
    super(
      `配置文件不存在：${path}\n` +
        "请创建该文件并按 docs/configuration.md 的字段表填写（至少要有 napcat.url），然后重启插件。",
    )
    this.name = "ConfigMissingError"
  }
}

/** 配置文件不是合法的 JSON 对象。 */
export class ConfigParseError extends Error {
  constructor(path: string, cause: unknown) {
    super(`配置文件解析失败：${path}（${cause instanceof Error ? cause.message : String(cause)}）`)
    this.name = "ConfigParseError"
  }
}

/** 配置文件的存放约定。 */
export const CONFIG_FILE_NAME = "config.json"
/** 配置文件的备份名。 */
export const CONFIG_BACKUP_NAME = "config.json.bak"
/** 配置文件权限：只有本人可读写。 */
export const CONFIG_FILE_MODE = 0o600
/** 配置目录权限：只有本人可进入。 */
export const CONFIG_DIR_MODE = 0o700
/** 外部改写配置文件后，去抖再通知的等待时间（毫秒）。 */
const WATCH_DEBOUNCE_MS = 150

/** 稀疏补丁：路径 → 新值；值为 `null` 表示删掉这个键。 */
export type ConfigPatch = Record<string, unknown>

/** 配置文件读写器。 */
export class ConfigStore {
  /** 配置文件路径。 */
  readonly path: string

  constructor(
    path: string,
    private readonly logger?: Logger,
  ) {
    this.path = path
  }

  /** 备份文件路径。 */
  get backupPath(): string {
    return `${this.path}.bak`
  }

  /**
   * 读取配置文件。
   *
   * @returns 文件里的原始内容；文件不存在时抛 `ConfigMissingError`。
   */
  async read(): Promise<Record<string, unknown>> {
    let text: string
    try {
      text = await readFile(this.path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ConfigMissingError(this.path)
      }
      throw error
    }
    try {
      const parsed = JSON.parse(text) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("顶层必须是一个 JSON 对象")
      }
      return parsed as Record<string, unknown>
    } catch (error) {
      throw new ConfigParseError(this.path, error)
    }
  }

  /**
   * 写配置文件。
   *
   * 原子写 + `0600` 权限；写之前把旧内容存成 `.bak`。
   */
  async write(raw: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: CONFIG_DIR_MODE })
    await this.backup()
    const text = `${JSON.stringify(raw, null, 2)}\n`
    await writeFileAtomic(this.path, text, { mode: CONFIG_FILE_MODE, fsync: true })
  }

  /** 把当前内容存成备份；没有旧文件时跳过。 */
  private async backup(): Promise<void> {
    try {
      const text = await readFile(this.path, "utf8")
      await writeFileAtomic(this.backupPath, text, { mode: CONFIG_FILE_MODE })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      this.logger?.warn("备份配置文件失败", error)
    }
  }

  /**
   * 在现有内容上应用稀疏补丁。
   *
   * 只改动补丁里出现的路径；值为 `null` 表示删掉这个键，回到默认值。
   *
   * @returns 应用后的完整内容。
   */
  async patch(patch: ConfigPatch): Promise<Record<string, unknown>> {
    const raw = await this.read()
    for (const [path, value] of Object.entries(patch)) {
      const segments = path.split(".").filter(Boolean)
      if (segments.length === 0) continue
      let current = raw
      for (const segment of segments.slice(0, -1)) {
        const child = current[segment]
        if (!child || typeof child !== "object" || Array.isArray(child)) {
          const next: Record<string, unknown> = {}
          current[segment] = next
          current = next
          continue
        }
        current = child as Record<string, unknown>
      }
      const leaf = segments[segments.length - 1]
      if (leaf === undefined) continue
      if (value === null) delete current[leaf]
      else current[leaf] = value
    }
    return raw
  }

  /**
   * 监听配置文件的外部改动。
   *
   * @param onChange 文件内容变化时调用；读取失败只记日志，不打断监听。
   * @returns 停止监听的函数。
   */
  async watch(onChange: (raw: Record<string, unknown>) => void): Promise<() => void> {
    const watcher: FSWatcher = chokidar.watch(this.path, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: WATCH_DEBOUNCE_MS, pollInterval: 50 },
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const handler = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void this.read()
          .then((raw) => onChange(raw))
          .catch((error: unknown) => this.logger?.warn("读取改动后的配置文件失败", error))
      }, WATCH_DEBOUNCE_MS)
      timer.unref?.()
    }
    watcher.on("change", handler).on("add", handler)
    await new Promise<void>((resolve) => {
      watcher.once("ready", () => resolve())
    })
    return () => {
      if (timer) clearTimeout(timer)
      void watcher.close()
    }
  }
}
