/** QQ 会话目标：群聊或私聊。 */
export type ChatTarget = { kind: "group"; id: number } | { kind: "private"; id: number }

/** 目标在存储与 Map 中的唯一键，例如 `group:100`、`private:200`。 */
export function targetKey(target: ChatTarget): string {
  return `${target.kind}:${target.id}`
}

/** 日志与提示里使用的可读名称。 */
export function targetLabel(target: ChatTarget): string {
  return target.kind === "group" ? `群 ${target.id}` : `私聊 ${target.id}`
}

/** 机器人给目标建的会话标题；老版本只有群聊会话，标题就是这一种。 */
export function targetSessionTitle(target: ChatTarget): string {
  return target.kind === "group" ? `QQ 群 ${target.id}` : `QQ 私聊 ${target.id}`
}

/** 解析持久化键，仅接受 `group:<id>` 与 `private:<id>`。 */
export function parseTargetKey(key: string): ChatTarget | undefined {
  const separator = key.indexOf(":")
  if (separator <= 0) return undefined
  const kind = key.slice(0, separator)
  const id = Number(key.slice(separator + 1))
  if (!Number.isInteger(id) || id <= 0) return undefined
  if (kind === "group") return { kind: "group", id }
  if (kind === "private") return { kind: "private", id }
  return undefined
}
