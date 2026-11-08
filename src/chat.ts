/** QQ 会话目标：群聊或私聊。 */
export type ChatTarget = { kind: "group"; id: number } | { kind: "private"; id: number }

export interface TargetConfig {
  groups: readonly number[]
  users: readonly number[]
}

/** 目标在存储与 Map 中的唯一键，例如 `group:100`、`private:200`。 */
export function targetKey(target: ChatTarget): string {
  return `${target.kind}:${target.id}`
}

/** 日志与提示里使用的可读名称。 */
export function targetLabel(target: ChatTarget): string {
  return target.kind === "group" ? `群 ${target.id}` : `私聊 ${target.id}`
}

/** 目标是否仍在配置中启用。 */
export function isTargetEnabled(config: TargetConfig, target: ChatTarget): boolean {
  return target.kind === "group"
    ? config.groups.includes(target.id)
    : config.users.includes(target.id)
}

/** 命令结果的投递目标：优先会话绑定的目标，没有就用第一个配置目标。 */
export function commandTarget(
  config: TargetConfig,
  bound: ChatTarget | undefined,
): ChatTarget | undefined {
  if (bound && isTargetEnabled(config, bound)) return bound
  return configuredTargets(config)[0]
}

/** 配置里声明的全部目标。 */
export function configuredTargets(config: TargetConfig): ChatTarget[] {
  return [
    ...config.groups.map((id): ChatTarget => ({ kind: "group", id })),
    ...config.users.map((id): ChatTarget => ({ kind: "private", id })),
  ]
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
