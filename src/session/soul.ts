import { mkdir, readdir, readFile } from "node:fs/promises"
import { existsSync, statSync, watch, type FSWatcher } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { unrefTimer } from "../async"
import { seedFile } from "../seed"
import type { Logger } from "../logger"
import { buildSystemPrompt } from "./prompt"
import { checkSoulPath, readSoulContent, SOUL_DIR, type SoulGuardOptions } from "./soul-guard"

export { SOUL_DIR }

/** 默认角色设定文件名。 */
export const DEFAULT_SOUL_NAME = "default.txt"

/** 同时缓存多少份角色设定：超出后丢掉最早加载的。 */
const MAX_SOUL_STORES = 32

/** 文件变化后的合并等待时间，避免编辑器连续写盘时重复读取。 */
const RELOAD_DEBOUNCE_MS = 150

export interface SoulOptions extends SoulGuardOptions {
  /** 显式指定的角色设定文件或目录，优先于 soulName。 */
  soulPath?: string
  /** souls 目录里的文件名。 */
  soulName?: string
  /** 机器人工作目录：角色设定放这里，升级插件不会覆盖。 */
  home: string
  /** 插件所在目录，用于查找随包分发的初始角色设定。 */
  moduleDir: string
  /** 已知凭证明文：人格文件里出现就掩码或拒绝加载。 */
  secrets?: readonly string[]
}

/** 工作目录里的角色设定目录。 */
export function soulsDirectory(home: string): string {
  return join(home, SOUL_DIR)
}

/** 从 startDir 向上逐级查找随包分发的 souls 目录。 */
export function findSoulsDirectory(startDir: string, maxDepth = 5): string | undefined {
  let current = resolve(startDir)
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = join(current, SOUL_DIR)
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * 把随包分发的角色设定补进工作目录。
 *
 * 只补缺失的文件：插件升级不会覆盖用户改过的设定，首次启动则拿到一份能直接用的默认档。
 */
export async function seedSouls(
  options: Pick<SoulOptions, "home" | "moduleDir">,
  logger: Logger,
): Promise<void> {
  const target = soulsDirectory(options.home)
  await mkdir(target, { recursive: true, mode: 0o700 })
  const template = findSoulsDirectory(options.moduleDir)
  if (!template || resolve(template) === resolve(target)) return
  let entries
  try {
    entries = await readdir(template, { withFileTypes: true })
  } catch (error) {
    logger.debug("读取随包角色设定失败", error)
    return
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    // 已有同名文件说明用户改过或换过，seedFile 不会动它。
    await seedFile(join(template, entry.name), join(target, entry.name), logger)
  }
}

/**
 * 定位角色设定文件：显式路径优先，否则取工作目录 `souls/` 里的指定文件。
 *
 * 相对路径按工作目录解析，与项目目录无关。
 */
export function resolveSoulPath(options: SoulOptions): string {
  const name = options.soulName?.trim() || DEFAULT_SOUL_NAME
  const explicit = options.soulPath?.trim()
  if (!explicit) return join(soulsDirectory(options.home), name)

  const target = isAbsolute(explicit) ? explicit : resolve(options.home, explicit)
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
    const target = resolveSoulPath(this.options)
    const check = await checkSoulPath(target, this.options)
    if (!check.ok) {
      this.#text = ""
      if (check.missing) {
        // 文件还没建好：先盯着所在目录，等它出现再读。
        this.#path = target
        this.#logger.warn(`角色设定还不存在：${target}`)
        this.#watch()
        return
      }
      this.#path = undefined
      this.#logger.warn(`角色设定不可用：${check.reason}`)
      return
    }
    this.#path = check.path
    const content = await readSoulContent(check.path, this.options.secrets ?? [])
    if (content.reason) {
      this.#text = ""
      this.#logger.warn(`角色设定不可用：${content.reason}`)
      return
    }
    this.#text = content.text
    if (!this.#text) this.#logger.warn(`角色设定读取失败：${this.#path}`)
    else this.#logger.info(`角色设定已加载：${this.#path}`)
    this.#watch()
  }

  /** 重新读取角色设定文件，内容有变化时返回 true。 */
  async reload(): Promise<boolean> {
    if (!this.#path) return false
    const check = await checkSoulPath(this.#path, this.options)
    if (!check.ok) {
      this.#logger.warn(`角色设定不可用：${check.reason}`)
      return false
    }
    const content = await readSoulContent(check.path, this.options.secrets ?? [])
    if (content.reason) {
      this.#logger.warn(`角色设定不可用：${content.reason}`)
      return false
    }
    if (content.text === this.#text) return false
    this.#text = content.text
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
  /** 路径解析结果的缓存：同一份设定不用每轮都去 stat 一遍。 */
  readonly #resolved = new Map<string, string>()
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

  /** 某个路径或名字的角色设定；都没给时用默认档。 */
  async at(path: string | undefined, name?: string): Promise<SoulStore> {
    if (!path?.trim() && !name?.trim()) return this.loadDefault()
    const key = `${path ?? ""}\u0000${name ?? ""}`
    let absolute = this.#resolved.get(key)
    if (!absolute) {
      absolute = resolveSoulPath({ ...this.options, soulPath: path, soulName: name })
      this.#resolved.set(key, absolute)
      this.#evictResolved()
    }
    const cached = this.#stores.get(absolute)
    if (cached) return cached
    const store = new SoulStore({ ...this.options, soulPath: absolute }, this.logger)
    await store.load()
    this.#stores.set(absolute, store)
    this.#evict()
    return store
  }

  /** 缓存的设定份数有上限：超出后丢掉最早加载的，别让它无界增长。 */
  #evict(): void {
    while (this.#stores.size > MAX_SOUL_STORES) {
      const oldest = this.#stores.keys().next()
      if (oldest.done) break
      const store = this.#stores.get(oldest.value)
      if (store === this.#defaultStore) break
      this.#stores.delete(oldest.value)
      store?.dispose()
    }
  }

  /** 路径解析结果的缓存同样有上限：聊天数不封顶时这张表会一直涨。 */
  #evictResolved(): void {
    while (this.#resolved.size > MAX_SOUL_STORES) {
      const oldest = this.#resolved.keys().next()
      if (oldest.done) break
      this.#resolved.delete(oldest.value)
    }
  }

  dispose(): void {
    for (const store of this.#stores.values()) store.dispose()
    this.#stores.clear()
    this.#resolved.clear()
    this.#defaultStore = undefined
  }
}
