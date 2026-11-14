import { mkdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { parseTargetKey } from "../chat"
import { backupFile, DIR_MODE, writeJsonAtomic } from "../fs/atomic"
import { knownSecrets } from "../known-secrets"
import {
  parseChatOverrides,
  resolveChatOverridesPath,
  type ChatOverride,
  type ChatOverrideParseOptions,
} from "../overrides"
import { maskKnownSecrets } from "../sensitive"
import { copyToSafeMap, hasKey, isSafeKey, safeMap } from "../safe-object"
import { acquireStateLock } from "../state-lock"
import { defaultToolPolicy, parseToolPolicy, resolveToolProfilesPath } from "../tools/policy"
import type { PanelRuntime } from "./runtime"

/**
 * 面板里的两个独立配置文件：`chat-overrides.json` 与 `tool-profiles.json`。
 *
 * 两个文件都不是全局配置，粒度与生命周期都不一样，所以各自独立成页。
 * 校验一律复用运行时的解析函数：面板不该自己写一套规则，
 * 否则「面板里能过、机器人不认」的事迟早发生。
 */

/** 一个字段上的问题。 */
export interface DocumentProblem {
  /** 字段路径，例如 `chats.group:100`。 */
  path: string
  /** 出错原因，直接给用户看。 */
  message: string
}

/** 一个文档在接口里的样子。 */
export interface DocumentView {
  /** 文件的实际位置。 */
  path: string
  /** 文件是否存在。 */
  exists: boolean
  /** 生效值：解析之后的文档。 */
  value: unknown
  /** 文件里的原始内容。 */
  fileValue: unknown
  /** 解析告警：写错的字段只忽略这一项，其余照常生效。 */
  warnings: string[]
  /** 命中已知凭证、被掩码的字段路径。 */
  masked: string[]
}

/** 保存之后的结果。 */
export interface DocumentSaveResult {
  /** 保存后的文档视图。 */
  document: DocumentView
  /** 这次改动里的告警。 */
  warnings: string[]
  /** 是否需要重启才能生效。 */
  restartRequired: boolean
  /** 生效时机说明。 */
  note: string
}

/** 会话覆盖里允许出现的字段；与 `ChatOverride` 一一对应。 */
const CHAT_OVERRIDE_FIELDS = [
  "wake",
  "wake.prefixes",
  "proactive.enabled",
  "proactive.startProbability",
  "collect.privateMs",
  "collect.groupMs",
  "agent",
  "model",
  "soulPath",
  "soulName",
] as const

/** 配置档名字的约束：不为空、不含空格与控制字符、最长 64 个字符。 */
const PROFILE_NAME = /^[^\s\p{C}]{1,64}$/u

/** 内置配置档的名字；这些档不能删，但可以覆盖。 */
const BUILTIN_PROFILES = Object.keys(defaultToolPolicy().profiles)

/** 会话覆盖文件里允许出现的顶层字段。 */
const CHAT_OVERRIDE_KEYS = ["chats"] as const

/** 工具配置文件里允许出现的顶层字段。 */
const TOOL_POLICY_KEYS = ["defaultProfile", "profiles", "chats"] as const

/** 保存文档时的锁重试参数。 */
const LOCK_RETRIES = { retries: 10, factor: 1.5, minTimeout: 20, maxTimeout: 200 }

/**
 * 配置档名字是否可用。
 *
 * 原型上的属性名（`__proto__` 之类）也要挡掉：拿它们索引普通对象会命中
 * `Object.prototype`，「这个档存在吗」这类判断永远为真。
 */
function isProfileName(name: string): boolean {
  return isSafeKey(name) && PROFILE_NAME.test(name)
}

/** 判断是不是普通对象（数组与 null 都不算）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/**
 * 掩码文档里的已知凭证。
 *
 * 命中时只记下字段路径，值换成占位符：面板不把凭证原样回显。
 * 路径取到「属性」一级，数组算一个属性，这样前端能整段跳过不动它。
 */
function maskDocument(
  value: unknown,
  secrets: readonly string[],
  base: string,
  paths: string[],
): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const masked = maskKnownSecrets(value, secrets)
    if (masked === value) return { value, changed: false }
    paths.push(base)
    return { value: masked, changed: true }
  }
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const masked = maskDocument(item, secrets, base, paths)
      if (masked.changed) changed = true
      return masked.value
    })
    if (changed) {
      paths.push(base)
      return { value: next, changed: true }
    }
    return { value: next, changed: false }
  }
  if (isPlainObject(value)) {
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const path = base ? `${base}.${key}` : key
      const masked = maskDocument(item, secrets, path, paths)
      if (masked.changed) changed = true
      // 用 defineProperty 复制：`__proto__` 这类键走赋值会落到原型上，
      // 键不再是自有属性，序列化时还会被丢掉，面板看到的内容就和磁盘对不上了。
      Object.defineProperty(next, key, {
        value: masked.value,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return { value: next, changed }
  }
  return { value, changed: false }
}

/** 掩码一份文档，并给出被掩码的字段路径。 */
function maskView(
  value: unknown,
  secrets: readonly string[],
): { value: unknown; masked: string[] } {
  if (secrets.length === 0) return { value, masked: [] }
  const paths: string[] = []
  const masked = maskDocument(value, secrets, "", paths)
  return { value: masked.value, masked: paths }
}

/** 读一个 JSON 文件；不存在或读不了时返回 undefined。 */
async function readJsonFile(path: string): Promise<{ raw: unknown; exists: boolean }> {
  const info = await stat(path).catch(() => undefined)
  if (!info) return { raw: undefined, exists: false }
  try {
    const text = await readFile(path, "utf8")
    return { raw: JSON.parse(text), exists: true }
  } catch {
    // 文件在但读不了或不是合法 JSON：当作空文档处理，保存时会重写它。
    return { raw: undefined, exists: true }
  }
}

/** 写文件：先备份，再原子写。权限与 `config.json` 一致。 */
async function writeDocument(path: string, value: unknown): Promise<void> {
  await backupFile(path)
  await writeJsonAtomic(path, value)
}

/** 一次保存的结果：写成功、写不合法，或者锁被占用。 */
type SaveOutcome<T> = { status: "saved"; result: T } | { status: "invalid" } | { status: "busy" }

/**
 * 在文件锁保护下读-改-写一个文档。
 *
 * 面板的保存是「读文件 → 合并 → 写回」：没有互斥的话两个并发请求会互相覆盖，
 * 后写的拿自己的旧视图盖掉先写的改动，而且谁也不报错。
 * 锁文件就放在文档旁边，两份文档各锁各的。
 */
async function withDocumentLock<T>(
  path: string,
  run: () => Promise<SaveOutcome<T>>,
): Promise<SaveOutcome<T>> {
  const lockPath = join(dirname(path), `.${basename(path)}.lock`)
  await mkdir(dirname(lockPath), { recursive: true, mode: DIR_MODE })
  const lock = await acquireStateLock(lockPath, { retries: LOCK_RETRIES })
  if (!lock) return { status: "busy" }
  try {
    return await run()
  } finally {
    await lock.release()
  }
}

/** 角色设定路径的边界选项：允许根来自配置。 */
function soulParseOptions(runtime: PanelRuntime): ChatOverrideParseOptions {
  return {
    home: runtime.home.directory,
    allowedPaths: runtime.config.soul?.allowedPaths ?? [],
  }
}

/** 面板拿到的会话覆盖文件路径。 */
export function chatOverridesPath(runtime: PanelRuntime): string {
  return resolveChatOverridesPath(runtime.config, runtime.home.directory)
}

/** 面板拿到的工具配置文件路径。 */
export function toolProfilesPath(runtime: PanelRuntime): string {
  return resolveToolProfilesPath(runtime.config, runtime.home.directory)
}

/** 读取会话覆盖文件并给出视图。 */
export async function readChatOverrides(runtime: PanelRuntime): Promise<DocumentView> {
  const path = chatOverridesPath(runtime)
  const { raw, exists } = await readJsonFile(path)
  const warnings: string[] = []
  const value = parseChatOverrides(
    raw,
    (message) => warnings.push(message),
    soulParseOptions(runtime),
  )
  const secrets = knownSecrets(runtime.config)
  const maskedValue = maskView(value, secrets)
  const maskedFile = maskView(raw ?? null, secrets)
  return {
    path,
    exists,
    value: maskedValue.value,
    fileValue: maskedFile.value,
    // 告警去重：同一句话出现两次时，页面上不该挂两个一模一样的条目。
    warnings: [...new Set(warnings)],
    masked: [...new Set([...maskedValue.masked, ...maskedFile.masked])],
  }
}

/** 读取工具配置文件并给出视图。 */
export async function readToolProfiles(runtime: PanelRuntime): Promise<DocumentView> {
  const path = toolProfilesPath(runtime)
  const { raw, exists } = await readJsonFile(path)
  const warnings: string[] = []
  const value = parseToolPolicy(raw, (message) => warnings.push(message))
  const secrets = knownSecrets(runtime.config)
  const maskedValue = maskView(value, secrets)
  const maskedFile = maskView(raw ?? null, secrets)
  return {
    path,
    exists,
    value: maskedValue.value,
    fileValue: maskedFile.value,
    warnings: [...new Set(warnings)],
    masked: [...new Set([...maskedValue.masked, ...maskedFile.masked])],
  }
}

/**
 * 应用会话覆盖的改动并保存。
 *
 * 改动是稀疏的：只有请求里出现的聊天与字段才会变，
 * 没提到的字段保持原样（被掩码的凭证也就不会被抹掉）。
 */
export async function saveChatOverrides(
  runtime: PanelRuntime,
  body: unknown,
): Promise<{ problems: DocumentProblem[]; result?: DocumentSaveResult }> {
  const problems: DocumentProblem[] = []
  if (!isPlainObject(body)) {
    return { problems: [{ path: "", message: "请求体必须是一个 JSON 对象" }] }
  }
  const patch = body.chats
  if (patch !== undefined && !isPlainObject(patch)) {
    problems.push({ path: "chats", message: "chats 必须是对象" })
  }
  if (problems.length > 0) return { problems }

  const path = chatOverridesPath(runtime)
  const saved = await withDocumentLock(path, async () => {
    const { raw } = await readJsonFile(path)
    const source = isPlainObject(raw) ? raw : {}
    // 文件里的其它顶层键原样保留：面板只管自己那几个字段，不该把别的抹掉。
    const base = isPlainObject(source.chats) ? copyToSafeMap(source.chats) : safeMap()
    const chats = isPlainObject(patch) ? patch : {}
    const warnings: string[] = []
    for (const key of Object.keys(body)) {
      if (!(CHAT_OVERRIDE_KEYS as readonly string[]).includes(key)) {
        warnings.push(`未知字段 ${key}，已忽略`)
      }
    }

    for (const [key, entry] of Object.entries(chats)) {
      const field = `chats.${key}`
      if (!parseTargetKey(key)) {
        problems.push({ path: field, message: "聊天键必须是 group:<群号> 或 private:<账号>" })
        continue
      }
      if (entry === null) {
        if (!hasKey(base, key)) {
          problems.push({ path: field, message: `会话覆盖 ${key} 不存在` })
          continue
        }
        delete base[key]
        continue
      }
      if (!isPlainObject(entry)) {
        problems.push({ path: field, message: "会话覆盖必须是对象" })
        continue
      }
      const exists = hasKey(base, key)
      const current = isPlainObject(base[key]) ? { ...base[key] } : {}
      const known = Object.entries(entry).filter(([name]) =>
        (CHAT_OVERRIDE_FIELDS as readonly string[]).includes(name),
      )
      for (const [name] of Object.entries(entry)) {
        if (!(CHAT_OVERRIDE_FIELDS as readonly string[]).includes(name)) {
          warnings.push(`会话覆盖 ${key} 的 ${name} 不是支持的字段，已忽略`)
        }
      }
      if (known.length === 0) {
        // 这一条没有能保存的字段：只告警，不动文件。
        warnings.push(`会话覆盖 ${key} 没有可保存的字段，已忽略`)
        continue
      }
      // 键本来就不存在，而这次提交的字段全是「删掉」：这是清空，不是新建。
      if (!exists && known.every(([, value]) => value === null)) {
        problems.push({ path: field, message: `会话覆盖 ${key} 不存在，不能靠清空字段来新建` })
        continue
      }
      for (const [name, value] of known) {
        if (value === null) {
          delete current[name]
          continue
        }
        current[name] = value
      }
      // 字段被删光了：这一条已经没有内容，等同于删掉它。
      if (CHAT_OVERRIDE_FIELDS.every((name) => current[name] === undefined)) {
        delete base[key]
        continue
      }
      if (current.wake === "prefix") {
        const prefixes = current["wake.prefixes"]
        if (!Array.isArray(prefixes) || prefixes.length === 0) {
          problems.push({
            path: `chats.${key}.wake.prefixes`,
            message: "选择 prefix 唤醒时必须写至少一个前缀",
          })
          continue
        }
      }
      // 用解析器把这一条覆盖收拾干净：写错的字段只丢这一项，其余照常写进去。
      const parsed = parseChatOverrides(
        { chats: { [key]: current } },
        (message) => {
          warnings.push(message)
        },
        soulParseOptions(runtime),
      )
      const normalized: ChatOverride = { ...(parsed.chats[key] ?? {}) }
      // 角色设定路径超出允许目录时解析器会丢掉它：文件里保留用户的原意，
      // 运行时不会加载，告警里说清楚。
      if (typeof current.soulPath === "string" && normalized.soulPath === undefined) {
        normalized.soulPath = current.soulPath
      }
      if (typeof current.soulName === "string" && normalized.soulName === undefined) {
        normalized.soulName = current.soulName
      }
      base[key] = normalized
    }
    if (problems.length > 0) return { status: "invalid" }

    const next = copyToSafeMap(source)
    delete next.chats
    next.chats = base
    await writeDocument(path, next)

    const document = await readChatOverrides(runtime)
    const expected = parseChatOverrides(next, () => undefined, soulParseOptions(runtime))
    const live = await runtime.overrides?.current()
    const applied = live ? JSON.stringify(live.chats) === JSON.stringify(expected.chats) : false
    const restartRequired = runtime.overrides ? !applied : true
    const note = restartRequired
      ? "已保存，但运行时没有热加载这条配置，需要重启机器人才能生效。"
      : "已保存，会话覆盖会在下一条消息到达时生效，无需重启。"
    return {
      status: "saved",
      result: {
        document,
        warnings: [...new Set([...warnings, ...document.warnings])],
        restartRequired,
        note,
      },
    }
  })

  if (saved.status === "busy") {
    return { problems: [{ path: "", message: "文件正被其它请求修改，请稍后重试" }] }
  }
  if (saved.status === "invalid") return { problems }
  return { problems: [], result: saved.result }
}

/**
 * 应用工具配置的改动并保存。
 *
 * 改动是稀疏的：只有请求里出现的配置档与聊天映射才会变。
 */
export async function saveToolProfiles(
  runtime: PanelRuntime,
  body: unknown,
): Promise<{ problems: DocumentProblem[]; result?: DocumentSaveResult }> {
  const problems: DocumentProblem[] = []
  if (!isPlainObject(body)) {
    return { problems: [{ path: "", message: "请求体必须是一个 JSON 对象" }] }
  }
  const profilePatch = body.profiles
  const chatPatch = body.chats
  if (profilePatch !== undefined && !isPlainObject(profilePatch)) {
    problems.push({ path: "profiles", message: "profiles 必须是对象" })
  }
  if (chatPatch !== undefined && !isPlainObject(chatPatch)) {
    problems.push({ path: "chats", message: "chats 必须是对象" })
  }
  if (problems.length > 0) return { problems }

  const path = toolProfilesPath(runtime)
  const saved = await withDocumentLock(path, async () => {
    const { raw } = await readJsonFile(path)
    const source = isPlainObject(raw) ? raw : {}
    const baseProfiles: Record<string, unknown> = isPlainObject(source.profiles)
      ? copyToSafeMap(source.profiles)
      : safeMap()
    const baseChats: Record<string, unknown> = isPlainObject(source.chats)
      ? copyToSafeMap(source.chats)
      : safeMap()
    let defaultProfile = typeof source.defaultProfile === "string" ? source.defaultProfile : ""
    // 置空表示回到内置默认档：文件里干脆不写这个键，界面也就能显示「跟随默认」。
    let omitDefault = false
    const warnings: string[] = []
    for (const key of Object.keys(body)) {
      if (!(TOOL_POLICY_KEYS as readonly string[]).includes(key)) {
        warnings.push(`未知字段 ${key}，已忽略`)
      }
    }
    const deletedProfiles = new Set<string>()

    for (const [name, entry] of Object.entries(isPlainObject(profilePatch) ? profilePatch : {})) {
      const field = `profiles.${name}`
      if (!isProfileName(name)) {
        problems.push({
          path: field,
          message: "配置档名字不能为空、不能含空格或控制字符，最长 64 个字符",
        })
        continue
      }
      if (entry === null) {
        if (BUILTIN_PROFILES.includes(name) && !hasKey(baseProfiles, name)) {
          problems.push({ path: field, message: `内置配置档 ${name} 不能删除` })
          continue
        }
        if (!hasKey(baseProfiles, name)) {
          problems.push({ path: field, message: `配置档 ${name} 不存在` })
          continue
        }
        delete baseProfiles[name]
        deletedProfiles.add(name)
        continue
      }
      if (!isPlainObject(entry)) {
        problems.push({ path: field, message: "配置档必须是对象" })
        continue
      }
      const exists = hasKey(baseProfiles, name)
      const current = isPlainObject(baseProfiles[name]) ? { ...baseProfiles[name] } : {}
      const known: Array<[string, unknown]> = []
      for (const [key, value] of Object.entries(entry)) {
        if (key !== "allow" && key !== "deny") {
          warnings.push(`配置档 ${name} 的 ${key} 不是支持的字段，已忽略`)
          continue
        }
        known.push([key, value])
      }
      if (known.length === 0) {
        // 这一档没有能保存的字段：只告警，不动文件。
        warnings.push(`配置档 ${name} 没有可保存的字段，已忽略`)
        continue
      }
      // 档本来就不存在，而这次提交的字段全是「删掉」：这是清空，不是新建。
      if (!exists && known.every(([, value]) => value === null)) {
        problems.push({ path: field, message: `配置档 ${name} 不存在，不能靠清空字段来新建` })
        continue
      }
      for (const [key, value] of known) {
        if (value === null) {
          delete current[key]
          continue
        }
        current[key] = value
      }
      // 用解析器把这一档收拾干净：列表里的非字符串项按解析器的规则丢掉。
      const parsed = parseToolPolicy({ profiles: { [name]: current } }, (message) => {
        warnings.push(message)
      })
      baseProfiles[name] = parsed.profiles[name] ?? { allow: [], deny: [] }
    }

    for (const [key, value] of Object.entries(isPlainObject(chatPatch) ? chatPatch : {})) {
      const field = `chats.${key}`
      if (!parseTargetKey(key)) {
        problems.push({ path: field, message: "聊天键必须是 group:<群号> 或 private:<账号>" })
        continue
      }
      if (value === null) {
        if (!hasKey(baseChats, key)) {
          problems.push({ path: field, message: `聊天映射 ${key} 不存在` })
          continue
        }
        delete baseChats[key]
        continue
      }
      if (typeof value !== "string" || !value.trim()) {
        problems.push({ path: field, message: "聊天映射必须是一个配置档名字" })
        continue
      }
      baseChats[key] = value.trim()
    }

    if (body.defaultProfile !== undefined) {
      if (body.defaultProfile === null) {
        // 置空表示回到内置默认档。
        defaultProfile = ""
        omitDefault = true
      } else if (typeof body.defaultProfile !== "string" || !body.defaultProfile.trim()) {
        problems.push({ path: "defaultProfile", message: "默认配置档必须是一个配置档名字" })
      } else {
        defaultProfile = body.defaultProfile.trim()
        omitDefault = false
      }
    }
    if (problems.length > 0) return { status: "invalid" }

    // 引用检查：档名必须存在，否则运行时会落到默认档，页面上写的意图等于白写。
    const effective = parseToolPolicy(
      { defaultProfile, profiles: baseProfiles, chats: baseChats },
      (message) => warnings.push(message),
    )
    if (defaultProfile && !hasKey(effective.profiles, defaultProfile)) {
      problems.push({
        path: "defaultProfile",
        message: deletedProfiles.has(defaultProfile)
          ? `配置档 ${defaultProfile} 已被删除，但 defaultProfile 还在用它`
          : `defaultProfile 指向不存在的配置档 ${defaultProfile}`,
      })
    }
    for (const [key, name] of Object.entries(effective.chats)) {
      if (!hasKey(effective.profiles, name)) {
        problems.push({
          path: `chats.${key}`,
          message: deletedProfiles.has(name)
            ? `配置档 ${name} 已被删除，但 chats.${key} 还在引用它`
            : `chats.${key} 指向不存在的配置档 ${name}`,
        })
      }
    }
    if (problems.length > 0) return { status: "invalid" }

    // 文件里的其它顶层键原样保留：面板只管自己那几个字段，不该把别的抹掉。
    const next = copyToSafeMap(source)
    delete next.defaultProfile
    delete next.profiles
    delete next.chats
    // 默认档没被指定过就不写进文件：写死了就分不清「用户选的」与「内置的」。
    if (!omitDefault && (defaultProfile || hasKey(source, "defaultProfile"))) {
      next.defaultProfile = defaultProfile || effective.defaultProfile
    }
    next.profiles = baseProfiles
    next.chats = baseChats
    await writeDocument(path, next)

    const document = await readToolProfiles(runtime)
    const expected = parseToolPolicy(next, () => undefined)
    const live = await runtime.policy?.current()
    const applied = live ? JSON.stringify(live) === JSON.stringify(expected) : false
    const restartRequired = runtime.policy ? !applied : true
    const note = restartRequired
      ? "已保存，但运行时没有热加载这条配置，需要重启机器人才能生效。"
      : "已保存，工具配置会在下一次工具调用前生效，无需重启。"
    return {
      status: "saved",
      result: {
        document,
        warnings: [...new Set([...warnings, ...document.warnings])],
        restartRequired,
        note,
      },
    }
  })

  if (saved.status === "busy") {
    return { problems: [{ path: "", message: "文件正被其它请求修改，请稍后重试" }] }
  }
  if (saved.status === "invalid") return { problems }
  return { problems: [], result: saved.result }
}
