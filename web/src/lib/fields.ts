import type { FieldMeta, FieldType } from "./types"

/**
 * 字段类型到控件的映射，以及补丁的组装。
 *
 * 表单完全由服务端给的字段元数据驱动：前端不写死任何一个字段名。
 */

/** 值的类型 → 控件类型。 */
export const FIELD_CONTROLS: Record<FieldType, string> = {
  boolean: "switch",
  number: "number",
  text: "text",
  secret: "secret",
  enum: "select",
  numberList: "tags",
  stringList: "tags",
  clock: "clock",
  modelRef: "model",
  path: "path",
}

/** 取对象里的路径值。 */
export function getPath(target: unknown, path: string): unknown {
  let current: unknown = target
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** 把值写进对象的路径；中间对象按需创建。 */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".")
  let current = target
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
  if (leaf === undefined) return
  current[leaf] = value
}

/** 把生效值摊平成「路径 → 值」。 */
export function flatten(values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(values)) setPath(result, path, value)
  return result
}

/** 字段的当前值：敏感字段没有明文，界面显示为空。 */
export function fieldValue(field: FieldMeta, values: Record<string, unknown>): unknown {
  if (field.secret) return ""
  return getPath(values, field.path)
}

/**
 * 把界面上的值变成提交用的补丁值。
 *
 * 清空文本类字段表示删掉这个键，回到默认值。
 */
export function patchValue(field: FieldMeta, value: unknown): unknown {
  if (field.secret) return value === "" ? undefined : value
  if (typeof value === "string" && value.trim() === "" && field.type !== "stringList") {
    if (field.type === "numberList") return []
    return null
  }
  return value
}

/** 数字输入框的值：空串表示没填。 */
export function numberValue(value: unknown): string {
  if (value === undefined || value === null) return ""
  return String(value)
}

/** 列表字段的值：统一成字符串数组。 */
export function listValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }
  return []
}

/** 时间字段的值：`HH:mm`。 */
export function clockValue(value: unknown): string {
  return typeof value === "string" ? value : ""
}
