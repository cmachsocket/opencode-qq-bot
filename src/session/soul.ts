import { readFile } from "node:fs/promises"
import { existsSync, statSync, watch, type FSWatcher } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { unrefTimer } from "../async"
import type { Logger } from "../logger"
import { buildSystemPrompt } from "./prompt"

/** 角色设定目录名。 */
export const SOUL_DIR = "souls"

/** 默认角色设定文件名。 */
export const DEFAULT_SOUL_NAME = "default.txt"

/** 文件变化后的合并等待时间，避免编辑器连续写盘时重复读取。 */
const RELOAD_DEBOUNCE_MS = 150

export interface SoulOptions {
  /** 显式指定的角色设定文件或目录，优先于 soulName。 */
  soulPath?: string
  /** souls 目录里的文件名。 */
  soulName?: string
  /** 插件所在目录，用于向上查找包内 souls 目录。 */
  moduleDir: string
  /** 相对路径的基准目录。 */
  cwd: string
}

/** 从 startDir 向上逐级查找 souls/<name>。 */
export function findSoulFile(
  startDir: string,
  name: string = DEFAULT_SOUL_NAME,
  maxDepth = 5,
): string | undefined {
  let current = resolve(startDir)
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = join(current, SOUL_DIR, name)
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/** 找不到文件时给出预期路径，文件补齐后可被监听器捡到。 */
function expectedSoulPath(startDir: string, name: string, maxDepth = 5): string {
  let current = resolve(startDir)
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const directory = join(current, SOUL_DIR)
    if (existsSync(directory)) return join(directory, name)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return join(resolve(startDir), SOUL_DIR, name)
}

/** 定位角色设定文件：显式路径优先，其次 souls 目录里的指定文件。 */
export function resolveSoulPath(options: SoulOptions): string {
  const name = options.soulName?.trim() || DEFAULT_SOUL_NAME
  const explicit = options.soulPath?.trim()
  if (!explicit) {
    return findSoulFile(options.moduleDir, name) ?? expectedSoulPath(options.moduleDir, name)
  }

  const target = isAbsolute(explicit) ? explicit : resolve(options.cwd, explicit)
  if (existsSync(target) && statSync(target).isDirectory()) return join(target, name)
  return target
}

/** 读取角色设定，失败时返回空字符串。 */
export async function loadSoul(path: string | undefined): Promise<string> {
  if (!path) return ""
  try {
    return await readFile(path, "utf-8")
  } catch {
    return ""
  }
}

/**
 * 角色设定持有者：读取生效的设定文件，并在文件变化后热更新。
 *
 * 提示词在每轮组装时读取当前内容，所以文件改动会在下一轮立即生效。
 */
export class SoulStore {
  #path: string | undefined
  #text = ""
  #watcher: FSWatcher | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #logger: Logger

  constructor(
    private readonly options: SoulOptions,
    logger: Logger,
  ) {
    this.#logger = logger
  }

  /** 生效的角色设定文件路径。 */
  get path(): string | undefined {
    return this.#path
  }

  /** 当前角色设定文本。 */
  get text(): string {
    return this.#text
  }

  /** 角色设定与固定守则组装出的系统提示词。 */
  get prompt(): string {
    return buildSystemPrompt(this.#text)
  }

  /** 解析路径、读取内容并开始监听文件变化。 */
  async load(): Promise<void> {
    this.#path = resolveSoulPath(this.options)
    this.#text = await loadSoul(this.#path)
    if (!this.#text) this.#logger.warn(`角色设定读取失败：${this.#path}`)
    else this.#logger.info(`角色设定已加载：${this.#path}`)
    this.#watch()
  }

  /** 重新读取角色设定文件，内容有变化时返回 true。 */
  async reload(): Promise<boolean> {
    if (!this.#path) return false
    const text = await loadSoul(this.#path)
    if (text === this.#text) return false
    this.#text = text
    this.#logger.info(`角色设定已更新：${this.#path}`)
    return true
  }

  dispose(): void {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.#watcher?.close()
    this.#watcher = undefined
  }

  /** 监听所在目录：编辑器多为替换文件，只盯目录才能捕捉到。 */
  #watch(): void {
    if (!this.#path) return
    const directory = dirname(this.#path)
    if (!existsSync(directory)) return
    try {
      this.#watcher = watch(directory, (_event, filename) => {
        const name = filename ? String(filename) : undefined
        if (name && !this.#matches(name, directory)) return
        this.#scheduleReload()
      })
    } catch (error) {
      this.#logger.warn("角色设定监听失败，改动后需要重载插件", error)
      return
    }
    unrefTimer(this.#watcher)
  }

  #matches(filename: string, directory: string): boolean {
    if (!this.#path) return false
    return resolve(directory, filename) === this.#path
  }

  #scheduleReload(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.reload()
    }, RELOAD_DEBOUNCE_MS)
    unrefTimer(this.#timer)
  }
}

/** 供测试与其它模块定位插件包目录。 */
export function packageDirectory(): string {
  return import.meta.dirname
}

/**
 * 多份角色设定的持有者：默认档 + 按路径懒加载。
 *
 * 每个聊天可以用覆盖配置指定自己的角色设定文件；同一路径只加载一次，
 * 每份设定各自监听文件变化，改完下一轮即生效。
 */
export class SoulLibrary {
  readonly #stores = new Map<string, SoulStore>()
  #defaultStore: SoulStore | undefined

  constructor(
    private readonly options: SoulOptions,
    private readonly logger: Logger,
  ) {}

  /** 加载并返回默认角色设定。 */
  async loadDefault(): Promise<SoulStore> {
    if (this.#defaultStore) return this.#defaultStore
    const path = resolveSoulPath(this.options)
    const store = new SoulStore({ ...this.options, soulPath: path }, this.logger)
    await store.load()
    this.#defaultStore = store
    this.#stores.set(path, store)
    return store
  }

  /** 某个路径的角色设定；路径为空时用默认档。 */
  async at(path: string | undefined): Promise<SoulStore> {
    const explicit = path?.trim()
    if (!explicit) return this.loadDefault()
    const absolute = isAbsolute(explicit) ? explicit : resolve(this.options.cwd, explicit)
    const cached = this.#stores.get(absolute)
    if (cached) return cached
    const store = new SoulStore({ ...this.options, soulPath: absolute }, this.logger)
    await store.load()
    this.#stores.set(absolute, store)
    return store
  }

  dispose(): void {
    for (const store of this.#stores.values()) store.dispose()
    this.#stores.clear()
    this.#defaultStore = undefined
  }
}
