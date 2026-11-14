import { readFile, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { ChatTarget } from "../chat"
import type { QQBotConfig } from "../config"
import type { Logger } from "../logger"
import { hasKey, isSafeKey, safeMap } from "../safe-object"

/**
 * 消息发送者的角色，决定用哪一档工具配置。
 *
 * `proactive` 是机器人主动发起话题时的角色：没有人参与这一轮，
 * 它读到的上下文完全来自聊天内容，所以权限最低。
 */
export type Role = "owner" | "admin" | "member" | "proactive"

/** 发送者角色：owner 最高，其次 admin，其余按普通成员处理。 */
export function roleOf(config: QQBotConfig, senderQQ: string): Role {
  const id = Number(senderQQ)
  if (config.ownerQQ !== undefined && id === config.ownerQQ) return "owner"
  if (config.admins.includes(id)) return "admin"
  return "member"
}

/** 聊天本身对应的角色：私聊按主人身份，群聊统一按普通成员。 */
export function roleForChat(config: QQBotConfig, target: ChatTarget): Role {
  return target.kind === "private" ? roleOf(config, String(target.id)) : "member"
}

/** 一档工具配置：allow 命中且 deny 不命中的工具才放行。 */
export interface ToolProfile {
  allow: string[]
  deny: string[]
}

/** `tool-profiles.json` 的结构。 */
export interface ToolPolicyFile {
  /** 没有按聊天指定的配置时用哪一档。 */
  defaultProfile: string
  /** 配置档：名字 → 允许 / 禁止的工具。 */
  profiles: Record<string, ToolProfile>
  /** 按聊天指定的配置档：`group:100` / `private:200` → 档名。 */
  chats: Record<string, string>
}

/**
 * 只对 owner 与 admin 开放的工具。
 *
 * 日记记录聊天内容，发文件能把本地文件送出去，收藏表情会往本机写文件：
 * 三者都只给管理档。用 deny 而不是不放进 allow，
 * 是为了用户自定义配置档时也不会误放开。
 */
const ADMIN_DENY = ["qq_diary_*", "qq_send_file", "qq_collect_sticker"]

/**
 * 只有 owner 能用的工具。
 *
 * owner 与 admin 共用 `admin` 档，所以「admin 不能用日记」只能在这里按角色判定，
 * 不能写进 `admin` 档的 deny：那会把 owner 一起禁掉。
 */
const OWNER_ONLY = ["qq_diary_*"]

/**
 * 只有管理角色（owner 与 admin）能用的工具。
 *
 * 按角色判定：用户自定义配置档写得多开放，这里也要再收一次。
 */
const ADMIN_ONLY = ["qq_collect_sticker"]

/** 内置默认值：普通聊天只留联网搜索、网页抓取和发消息工具，管理档全开。 */
export function defaultToolPolicy(): ToolPolicyFile {
  const profiles = safeMap<ToolProfile>()
  profiles.chat = { allow: ["websearch", "webfetch", "qq_*"], deny: [...ADMIN_DENY] }
  profiles.readonly = { allow: ["read", "glob", "grep", "qq_*"], deny: [...ADMIN_DENY] }
  // 主动说话没有人参与，权限不能跟着聊天内容走：与普通聊天同档。
  profiles.proactive = { allow: ["websearch", "webfetch", "qq_*"], deny: [...ADMIN_DENY] }
  profiles.admin = { allow: ["*"], deny: [] }
  return {
    defaultProfile: "chat",
    profiles,
    chats: safeMap<string>(),
  }
}

/** 默认的配置文件位置：工作目录下的 `tool-profiles.json`。 */
export function defaultToolProfilesPath(home: string): string {
  return join(home, "tool-profiles.json")
}

/**
 * 解析工具配置文件的实际位置。
 *
 * 配置里写了 `toolProfilesPath` 就按工作目录解析（绝对路径原样使用），
 * 没写就用工作目录下的默认位置。启动与面板共用这一份解析。
 */
export function resolveToolProfilesPath(
  config: { toolProfilesPath?: string },
  home: string,
): string {
  const configured = config.toolProfilesPath?.trim()
  return configured ? resolve(home, configured) : defaultToolProfilesPath(home)
}

/**
 * 判断工具名是否命中通配模式。
 *
 * 只支持 `*`（任意长度）和 `?`（单个字符），大小写敏感，必须整名匹配。
 */
export function globMatch(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  const source = escaped.replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${source}$`).test(name)
}

function readNames(value: unknown, warn: (message: string) => void, where: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    warn(`${where} 必须是字符串数组`)
    return []
  }
  const names: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string") {
      warn(`${where} 里有非字符串项：${String(entry)}`)
      continue
    }
    const name = entry.trim()
    if (!name || names.includes(name)) continue
    names.push(name)
  }
  return names
}

/**
 * 解析并校验配置内容。
 *
 * 解析失败不抛错：回退到内置默认值并告警，避免一个手写的逗号让机器人失去工具。
 */
export function parseToolPolicy(value: unknown, warn: (message: string) => void): ToolPolicyFile {
  const fallback = defaultToolPolicy()
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warn("工具配置必须是对象，已回退到内置默认值")
    return fallback
  }
  const raw = value as Record<string, unknown>
  const profiles = safeMap<ToolProfile>()
  const source = raw.profiles
  if (source !== undefined) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      warn("profiles 必须是对象，已回退到内置默认值")
      return fallback
    }
    for (const [name, entry] of Object.entries(source as Record<string, unknown>)) {
      if (!isSafeKey(name)) {
        warn(`工具配置档 ${name} 是保留名，已忽略`)
        continue
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        warn(`工具配置档 ${name} 必须是对象，已忽略`)
        continue
      }
      const profile = entry as Record<string, unknown>
      profiles[name] = {
        allow: readNames(profile.allow, warn, `${name}.allow`),
        deny: readNames(profile.deny, warn, `${name}.deny`),
      }
    }
  }
  // 用户没有覆盖的档沿用内置默认值，这样只写一档也能用。
  for (const [name, profile] of Object.entries(fallback.profiles)) {
    if (!hasKey(profiles, name)) profiles[name] = profile
  }
  const defaultProfile =
    typeof raw.defaultProfile === "string" && raw.defaultProfile.trim()
      ? raw.defaultProfile.trim()
      : fallback.defaultProfile
  if (!hasKey(profiles, defaultProfile)) {
    warn(`defaultProfile 指向不存在的配置档 ${defaultProfile}，已回退到 ${fallback.defaultProfile}`)
  }
  const chats = safeMap<string>()
  if (raw.chats !== undefined) {
    if (!raw.chats || typeof raw.chats !== "object" || Array.isArray(raw.chats)) {
      warn("chats 必须是对象，已忽略")
    } else {
      for (const [key, name] of Object.entries(raw.chats as Record<string, unknown>)) {
        if (typeof name !== "string" || !name.trim()) {
          warn(`chats.${key} 必须是配置档名字，已忽略`)
          continue
        }
        chats[key] = name.trim()
      }
    }
  }
  return {
    defaultProfile: hasKey(profiles, defaultProfile) ? defaultProfile : fallback.defaultProfile,
    profiles,
    chats,
  }
}

/**
 * 角色对应的配置档名字：owner 与 admin 用管理档，其他按聊天配置。
 *
 * 主动说话（`proactive`）固定用主动说话档：它没有人参与，
 * 不能因为聊天里有 owner 或管理员说过话就借到管理档的全开权限。
 */
export function profileNameFor(file: ToolPolicyFile, role: Role, chatKey: string): string {
  if (role === "owner" || role === "admin") {
    return hasKey(file.profiles, "admin") ? "admin" : file.defaultProfile
  }
  if (role === "proactive") {
    return hasKey(file.profiles, "proactive") ? "proactive" : file.defaultProfile
  }
  const named = file.chats[chatKey]
  if (named && hasKey(file.profiles, named)) return named
  return file.defaultProfile
}

/** 从工具名列表里筛出该配置档允许的项；deny 优先于 allow。 */
export function allowedTools(profile: ToolProfile, names: readonly string[]): string[] {
  // 配置档可能来自被污染过的文件：字段不是数组时按空列表算，不让整个机器人崩掉。
  const deny = Array.isArray(profile?.deny) ? profile.deny : []
  const allow = Array.isArray(profile?.allow) ? profile.allow : []
  const allowed = (name: string) =>
    !deny.some((pattern) => globMatch(pattern, name)) &&
    (allow.includes("*") || allow.some((pattern) => globMatch(pattern, name)))
  return names.filter(allowed)
}

/** 工具配置的读取与热加载。 */
export class ToolPolicy {
  private cached?: { mtime: number; file: ToolPolicyFile }

  constructor(
    private readonly path: string,
    private readonly logger: Logger,
  ) {}

  /** 当前生效的配置；文件改动后按 mtime 重新读取。 */
  async current(): Promise<ToolPolicyFile> {
    const info = await stat(this.path).catch(() => undefined)
    if (!info) {
      if (!this.cached) this.cached = { mtime: 0, file: defaultToolPolicy() }
      return this.cached.file
    }
    if (this.cached && this.cached.mtime === info.mtimeMs) return this.cached.file
    try {
      const text = await readFile(this.path, "utf8")
      const file = parseToolPolicy(JSON.parse(text), (message) => {
        this.logger.warn(`工具配置 ${this.path}：${message}`)
      })
      this.cached = { mtime: info.mtimeMs, file }
      return file
    } catch (error) {
      // 半写或语法错误时保留上一份可用配置，等下一次写入后再加载。
      this.logger.warn(`工具配置 ${this.path} 读取失败，继续沿用上一份配置`, error)
      if (!this.cached) this.cached = { mtime: 0, file: defaultToolPolicy() }
      return this.cached.file
    }
  }

  /** 某个角色在某个聊天里能用的工具子集。 */
  async allow(role: Role, chatKey: string, names: readonly string[]): Promise<Set<string>> {
    const file = await this.current()
    const name = profileNameFor(file, role, chatKey)
    const profile = hasKey(file.profiles, name) ? file.profiles[name] : undefined
    if (!profile) {
      // 找不到配置档时一律不放行：让配置坏了就等于机器人失去工具，比崩掉好。
      this.logger.warn(`工具配置 ${this.path}：找不到配置档 ${name}，本轮不放行任何工具`)
      return new Set<string>()
    }
    const allowed = new Set(allowedTools(profile, names))
    // 配置档只按工具名分配，日记这类只给 owner 的工具要在这里再按角色收一次。
    if (role !== "owner") {
      for (const name of allowed) {
        if (OWNER_ONLY.some((pattern) => globMatch(pattern, name))) allowed.delete(name)
      }
    }
    // 收藏表情会往本机写文件：只有管理角色能用，配置档放开也不行。
    if (role !== "owner" && role !== "admin") {
      for (const name of allowed) {
        if (ADMIN_ONLY.some((pattern) => globMatch(pattern, name))) allowed.delete(name)
      }
    }
    return allowed
  }

  /** 某个角色在某个聊天里生效的配置档名字，用于管理命令展示。 */
  async profileOf(role: Role, chatKey: string): Promise<string> {
    const file = await this.current()
    return profileNameFor(file, role, chatKey)
  }
}
