import { Model } from "@opencode/schema"
import { z } from "zod"
import { CONFIG_FIELDS, type ConfigField } from "./fields"
import type {
  AccessConfig,
  DiaryPush,
  LogLevel,
  ModelRef,
  ParsedConfig,
  QQBotConfig,
} from "./types"

/**
 * 由字段注册表生成配置产物：默认值、zod 校验、配置文件键集合与 JSON Schema。
 *
 * 注册表是唯一事实源：新增一个配置项只需要改 `fields.ts`。
 */

const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/
const TRUTHY = new Set(["1", "true", "yes", "on"])
const BOOLEAN_SPELLINGS = ["1", "0", "true", "false", "yes", "no", "on", "off"] as const
/** 合法的时刻格式：`HH:mm`。 */
const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** 配置告警回调。 */
export type ConfigWarning = (message: string) => void

/** 判断值是否算“已提供”，用于区分空值与写错的值。 */
function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ""
}

/** 把「数组或逗号分隔字符串」统一成数组；其它类型返回 undefined。 */
function toSource(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value
  return typeof value === "string" ? value.split(",") : undefined
}

/** 把数字数组或逗号分隔字符串整理成去重后的正整数列表。 */
function toIds(
  value: unknown,
  warn: ConfigWarning,
  label: string,
  noun: string,
): number[] | undefined {
  const source = toSource(value)
  if (!source) return undefined
  const ids: number[] = []
  const seen = new Set<number>()
  for (const entry of source) {
    const raw =
      typeof entry === "number" ? String(entry) : typeof entry === "string" ? entry.trim() : ""
    if (!raw) continue
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      warn(`${label} 忽略非法${noun}：${raw}`)
      continue
    }
    if (seen.has(parsed)) continue
    seen.add(parsed)
    ids.push(parsed)
  }
  return ids
}

/** 解析 "provider/model" 或 "provider/model/variant"，复用 SDK 的模型引用解析。 */
export function parseModelRef(value: unknown): ModelRef | undefined {
  const raw = typeof value === "string" ? value.trim() : ""
  if (!raw) return undefined
  const [providerID, id, variant, ...rest] = raw.split("/").filter(Boolean)
  if (!providerID || !id || rest.length > 0) return undefined
  try {
    const ref = Model.Ref.parse(`${providerID}/${id}${variant ? `#${variant}` : ""}`)
    return {
      providerID: ref.providerID,
      id: ref.id,
      ...(ref.variant ? { variant: ref.variant } : {}),
    }
  } catch {
    return undefined
  }
}

/** 深拷贝一份默认值：catch 分支不能把默认对象本身交出去。 */
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as unknown as T
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = clone(entry)
    }
    return result as T
  }
  return value
}

/** 字段树：一个节点要么是叶子字段，要么是下一层对象。 */
interface SchemaNode {
  /** 子节点，键是路径的一段。 */
  children: Map<string, SchemaNode>
  /** 叶子字段；对象节点为 undefined。 */
  field?: ConfigField
}

/** 由注册表长出字段树。 */
function buildTree(): SchemaNode {
  const root: SchemaNode = { children: new Map() }
  for (const field of CONFIG_FIELDS) {
    let node = root
    for (const segment of field.path.split(".")) {
      let child = node.children.get(segment)
      if (!child) {
        child = { children: new Map() }
        node.children.set(segment, child)
      }
      node = child
    }
    node.field = field
  }
  return root
}

const TREE = buildTree()

/** 取某个路径在对象里的值。 */
export function getConfigValue(target: unknown, path: string): unknown {
  let current: unknown = target
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** 把值写进对象的指定路径；中间对象必须已经存在。 */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".")
  let current: Record<string, unknown> = target
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment]
    if (!child || typeof child !== "object") return
    current = child as Record<string, unknown>
  }
  const leaf = segments[segments.length - 1]
  if (leaf === undefined) return
  current[leaf] = value
}

/** 编号名单里“群号”与“QQ 号”的叫法。 */
function idNoun(path: string): string {
  return path.toLowerCase().includes("group") ? "群号" : "QQ 号"
}

/** 数值字段的取值约束：范围、整数。 */
function numberConstraint(field: ConfigField): { check: z.ZodNumber; rule: string } {
  let check = z.number()
  const parts: string[] = []
  if (field.step === 1) {
    check = check.int()
    parts.push("必须是整数")
  }
  if (field.min !== undefined) {
    if (field.exclusiveMin) {
      check = field.min === 0 ? check.positive() : check.gt(field.min)
      parts.push(`必须大于 ${field.min}`)
    } else {
      check = check.min(field.min)
      parts.push(`不能小于 ${field.min}`)
    }
  }
  if (field.max !== undefined) {
    check = check.max(field.max)
    parts.push(`不能大于 ${field.max}`)
  }
  return { check, rule: parts.join("，") }
}

/** 单个字段的 zod 校验：非法值告警并回退到默认值。 */
function leafSchema(field: ConfigField, warn: ConfigWarning): z.ZodTypeAny {
  const path = field.path
  const fallback = field.default
  switch (field.type) {
    case "boolean": {
      const value = fallback as boolean
      return z
        .union([z.boolean(), z.string().trim().toLowerCase().pipe(z.enum(BOOLEAN_SPELLINGS))])
        .transform((entry) => (typeof entry === "boolean" ? entry : TRUTHY.has(entry)))
        .catch((ctx) => {
          if (present(ctx.value)) warn(`${path} 不是合法的布尔值：${String(ctx.value)}`)
          return value
        })
        .default(value)
    }
    case "number": {
      // 可选的单个编号：允许数字或数字字符串，非法值回退到未配置。
      if (fallback === undefined) {
        return z
          .unknown()
          .optional()
          .transform((entry) => {
            if (!present(entry)) return undefined
            const parsed =
              typeof entry === "number"
                ? entry
                : typeof entry === "string" && entry.trim() !== ""
                  ? Number(entry.trim())
                  : Number.NaN
            if (!Number.isInteger(parsed) || parsed <= 0) {
              warn(`${path} 不是合法的 QQ 号：${String(entry)}`)
              return undefined
            }
            return parsed
          })
      }
      const value = fallback as number
      const { check, rule } = numberConstraint(field)
      return z
        .union([z.number(), z.string().trim().regex(NUMBER).transform(Number)])
        .pipe(z.number().finite())
        .catch((ctx) => {
          if (present(ctx.value)) warn(`${path} 不是合法的数字：${String(ctx.value)}`)
          return value
        })
        .default(value)
        .pipe(check)
        .catch((ctx) => {
          if (present(ctx.value)) {
            warn(`${path} ${rule}，当前为 ${String(ctx.value)}，已回退到 ${value}`)
          }
          return value
        })
    }
    case "enum": {
      const options = field.options ?? []
      return z
        .unknown()
        .optional()
        .transform((value) => {
          if (!present(value)) return fallback
          const raw = typeof value === "string" ? value.trim().toLowerCase() : ""
          if (!raw) {
            warn(`${path} 不能为空，已回退到默认值`)
            return fallback
          }
          if (!options.includes(raw)) {
            warn(`${path} 不是合法的取值：${String(value)}（可用：${options.join("/")}）`)
            return fallback
          }
          return raw
        })
    }
    case "numberList": {
      const list = Array.isArray(fallback) ? (fallback as number[]) : []
      return z
        .unknown()
        .optional()
        .transform((entry) => {
          if (entry === undefined || entry === null) return [...list]
          const parsed = toIds(entry, warn, path, idNoun(path))
          if (!parsed) {
            if (present(entry)) warn(`${path} 解析不出${idNoun(path)}：${String(entry)}`)
            return [...list]
          }
          return parsed
        })
    }
    case "stringList": {
      const list = Array.isArray(fallback) ? (fallback as string[]) : []
      return z
        .unknown()
        .optional()
        .transform((value) => {
          if (value === undefined || value === null) return [...list]
          const source = toSource(value)
          if (!source) {
            if (present(value)) warn(`${path} 必须是字符串或字符串数组：${String(value)}`)
            return [...list]
          }
          const items: string[] = []
          for (const entry of source) {
            const raw = typeof entry === "string" ? entry.trim() : ""
            if (!raw) continue
            if (items.includes(raw)) continue
            items.push(raw)
          }
          return items
        })
    }
    case "clock":
      return z
        .unknown()
        .optional()
        .transform((value) => {
          if (!present(value)) return fallback
          if (typeof value !== "string") {
            warn(`${path} 必须是字符串：${String(value)}`)
            return fallback
          }
          const trimmed = value.trim()
          if (!CLOCK.test(trimmed)) {
            warn(`${path} 不是合法的时刻：${trimmed}（应为 HH:mm）`)
            return fallback
          }
          return trimmed
        })
    case "modelRef":
      return z
        .unknown()
        .optional()
        .transform((value) => {
          if (!present(value)) return fallback
          const parsed = parseModelRef(value)
          if (!parsed) {
            warn(`${path} 格式无效：${String(value)}（应为 provider/model[/variant]）`)
            return fallback
          }
          return parsed
        })
    case "path":
      // 路径允许留空（空表示默认位置），非字符串回退到默认值。
      return z
        .unknown()
        .optional()
        .transform((value) => {
          if (value === undefined || value === null) return fallback
          if (typeof value !== "string") {
            warn(`${path} 必须是字符串：${String(value)}`)
            return fallback
          }
          return value.trim()
        })
    case "text":
    case "secret":
      return z
        .unknown()
        .optional()
        .transform((value) => {
          if (!present(value)) return fallback
          if (typeof value !== "string") {
            warn(`${path} 必须是字符串：${String(value)}`)
            return fallback
          }
          const trimmed = value.trim()
          if (!trimmed) {
            warn(`${path} 不能为空，已回退到默认值`)
            return fallback
          }
          return trimmed
        })
  }
}

/** 对象节点的默认值：只包含这一层注册表声明过的字段。 */
function nodeDefaults(node: SchemaNode): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, child] of node.children) {
    if (child.field) {
      if (child.field.default === undefined) continue
      result[key] = clone(child.field.default)
      continue
    }
    result[key] = nodeDefaults(child)
  }
  return result
}

/** 递归生成 zod schema。 */
function nodeSchema(node: SchemaNode, warn: ConfigWarning): z.ZodTypeAny {
  if (node.field) return leafSchema(node.field, warn)
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, child] of node.children) {
    shape[key] = nodeSchema(child, warn)
  }
  return z.object(shape).prefault({}).catch(nodeDefaults(node))
}

/**
 * 用字段注册表生成配置校验 schema。
 *
 * 语义与旧版一致：非法值告警并回退到默认值，不让一个手写错的值让插件起不来。
 */
export function createConfigSchema(warn: ConfigWarning): z.ZodType<ParsedConfig> {
  return nodeSchema(TREE, warn) as unknown as z.ZodType<ParsedConfig>
}

/** 除 NapCat 连接信息外的全部默认值。 */
export const DEFAULT_CONFIG: Omit<QQBotConfig, "napcat"> = nodeDefaults(TREE) as Omit<
  QQBotConfig,
  "napcat"
>

/** NapCat 连接信息的默认值（URL 必填，因此没有默认值）。 */
export const DEFAULT_NAPCAT: { url?: string; token?: string } = {}

/**
 * 配置文件里允许出现的键：路径前缀 → 该层的合法子键。
 *
 * 键集合由注册表生成：注册表里没有的键就是未知键，读文件时告警但保留原样。
 */
export const FILE_KEYS: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const keys = new Map<string, Set<string>>()
  for (const field of CONFIG_FIELDS) {
    const segments = field.path.split(".")
    for (let index = 0; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index).join(".")
      const key = segments[index]
      if (key === undefined) continue
      const allowed = keys.get(prefix) ?? new Set<string>()
      allowed.add(key)
      keys.set(prefix, allowed)
    }
  }
  return keys
})()

/**
 * 报告配置文件里被 schema 忽略的未知键。
 *
 * 按层级逐层检查：`access.allow.groups` 这类嵌套路径也能报出来。
 */
export function warnUnknownFileKeys(raw: Record<string, unknown>, warn: ConfigWarning): void {
  const walk = (value: Record<string, unknown>, path: string): void => {
    const allowed = FILE_KEYS.get(path)
    for (const key of Object.keys(value)) {
      const childPath = path ? `${path}.${key}` : key
      if (allowed && !allowed.has(key)) {
        warn(`配置文件 未知配置项：${childPath}`)
        continue
      }
      const child = value[key]
      if (!child || typeof child !== "object" || Array.isArray(child)) continue
      walk(child as Record<string, unknown>, childPath)
    }
  }
  walk(raw, "")
}

/** 注册表里声明为热更新的字段。 */
export const HOT_FIELDS: readonly ConfigField[] = CONFIG_FIELDS.filter((field) => field.hot)

/**
 * 把新配置里的热字段写进正在生效的配置对象。
 *
 * 只改叶子值，中间对象保持同一个引用：运行中的模块早就抓住了这些对象，
 * 换掉对象它们就看不到新值了。
 */
export function applyHotFields(live: QQBotConfig, next: QQBotConfig): void {
  for (const field of HOT_FIELDS) {
    const value = getConfigValue(next, field.path)
    setPath(live as unknown as Record<string, unknown>, field.path, clone(value))
  }
}

/**
 * 单个字段的严格校验 schema。
 *
 * 与解析用的 schema 不同：这里不会把非法值回退成默认值，而是直接报错，
 * 面板保存时才能把「哪个字段写错了」告诉用户。
 */
export function createStrictFieldSchema(field: ConfigField): z.ZodType {
  const strictId = z
    .union([z.number(), z.string().trim().regex(/^\d+$/).transform(Number)])
    .pipe(z.number().int().positive())
  const strictIdFromText = z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Number(value))
    .pipe(z.number().int().positive())
  switch (field.type) {
    case "boolean":
      return z
        .union([z.boolean(), z.string().trim().toLowerCase().pipe(z.enum(BOOLEAN_SPELLINGS))])
        .transform((value) => (typeof value === "boolean" ? value : TRUTHY.has(value)))
    case "number": {
      const { check } = numberConstraint(field)
      if (field.default === undefined) return strictId
      return z
        .union([z.number(), z.string().trim().regex(NUMBER).transform(Number)])
        .pipe(z.number().finite())
        .pipe(check)
    }
    case "enum": {
      const options = field.options ?? []
      return z
        .string()
        .trim()
        .toLowerCase()
        .refine((value) => options.includes(value), {
          message: `必须是 ${options.join("/")} 之一`,
        })
    }
    case "numberList":
      return z.union([
        z.array(strictId),
        z
          .string()
          .transform((value) =>
            value
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
          )
          .pipe(z.array(strictIdFromText)),
      ])
    case "stringList":
      return z
        .union([
          z.array(z.string()),
          z.string().transform((value) =>
            value
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
          ),
        ])
        .pipe(z.array(z.string().min(1)))
    case "clock":
      return z.string().trim().regex(CLOCK, "必须是 HH:mm 格式的时刻")
    case "modelRef":
      return z
        .string()
        .trim()
        .refine((value) => parseModelRef(value) !== undefined, {
          message: "格式应为 provider/model[/variant]",
        })
    case "path":
      return z.string().trim()
    case "text":
    case "secret":
      return z.string().trim().min(1, "不能为空")
  }
}

/** JSON Schema 里每个字段的取值规则。 */
function jsonSchemaFor(field: ConfigField): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  switch (field.type) {
    case "boolean":
      base.type = "boolean"
      break
    case "number":
      base.type = "number"
      if (field.min !== undefined) {
        if (field.exclusiveMin) {
          base.exclusiveMinimum = field.min
          if (field.min === 0) base.exclusiveMinimum = 0
        } else {
          base.minimum = field.min
        }
      }
      if (field.max !== undefined) base.maximum = field.max
      if (field.step === 1) base.type = "integer"
      break
    case "enum":
      base.type = "string"
      base.enum = [...(field.options ?? [])]
      break
    case "numberList":
      base.type = "array"
      base.items = { type: "integer", minimum: 1 }
      break
    case "stringList":
      base.type = "array"
      base.items = { type: "string" }
      break
    case "clock":
      base.type = "string"
      base.pattern = "^([01]?\\d|2[0-3]):([0-5]\\d)$"
      break
    case "modelRef":
      base.type = "string"
      break
    default:
      base.type = "string"
      break
  }
  base["x-label"] = field.label
  if (field.description) base["x-description"] = field.description
  if (field.required && base.type === "string") base.minLength = 1
  base["x-ui"] = {
    type: field.type,
    group: field.group,
    hot: field.hot === true,
    secret: field.secret === true,
    ...(field.options ? { options: [...field.options] } : {}),
    ...(field.min !== undefined ? { min: field.min } : {}),
    ...(field.max !== undefined ? { max: field.max } : {}),
    ...(field.step !== undefined ? { step: field.step } : {}),
  }
  return base
}

/** 递归生成 JSON Schema。 */
function jsonSchemaNode(node: SchemaNode): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, child] of node.children) {
    if (child.field) {
      properties[key] = jsonSchemaFor(child.field)
      if (child.field.required) required.push(key)
      continue
    }
    properties[key] = jsonSchemaNode(child)
  }
  return required.length > 0
    ? { type: "object", properties, required }
    : { type: "object", properties }
}

/**
 * 生成 JSON Schema：前端用它做校验，规则只有一份。
 *
 * 面板用 ajv 直接校验这份 schema，不在前端另写一套 min/max/enum 判断。
 */
export function configJsonSchema(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "opencode-qq-bot 配置",
    ...jsonSchemaNode(TREE),
    additionalProperties: true,
  }
}

/** 判定配置里某个字段是否敏感。 */
export function isSecretField(path: string): boolean {
  return CONFIG_FIELDS.find((field) => field.path === path)?.secret === true
}

/**
 * 必填项能不能被删掉。
 *
 * 值为 `null` 表示删键；必填项删掉之后配置文件就装不起来，
 * 所以这里直接给出原因，由调用方拒绝这次改动。
 *
 * @returns 出问题的说明；没问题时返回 undefined。
 */
export function requiredFieldProblem(path: string, value: unknown): string | undefined {
  if (value !== null) return undefined
  const field = CONFIG_FIELDS.find((entry) => entry.path === path)
  if (!field?.required) return undefined
  return `${field.label}（${path}）必填，不能删除`
}

/** 日志级别与日记推送方式的取值集合，供外部复用。 */
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"]
export const DIARY_PUSH_MODES: readonly DiaryPush[] = ["owner", "group", "none"]
export const EVENT_CATEGORIES: readonly string[] = ["message", "notice"]

/** 准入配置的默认值。 */
export const DEFAULT_ACCESS: AccessConfig = {
  allow: { groups: [], users: [] },
  deny: { groups: [], users: [] },
  allowAllWhenEmpty: false,
}
