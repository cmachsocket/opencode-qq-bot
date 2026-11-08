import { type ChatTarget } from "./chat"

/** 一类目标的名单：群号与私聊 QQ 号。 */
export interface TargetList {
  /** 群号。 */
  groups: number[]
  /** 私聊 QQ 号。 */
  users: number[]
}

/** 准入配置：放行名单、拒绝名单，以及名单为空时是否放行。 */
export interface AccessConfig {
  /** 放行名单；某一类为空时看 allowAllWhenEmpty。 */
  allow: TargetList
  /** 拒绝名单，优先于放行名单。 */
  deny: TargetList
  /** 放行名单的某一类为空时，是否放行该类的全部目标。 */
  allowAllWhenEmpty: boolean
}

/** 空名单。 */
export function emptyTargetList(): TargetList {
  return { groups: [], users: [] }
}

/** 取某一类目标的名单。 */
function listFor(list: TargetList, kind: ChatTarget["kind"]): number[] {
  return kind === "group" ? list.groups : list.users
}

/**
 * 目标是否放行。
 *
 * 判定顺序：拒绝名单命中就不放行；放行名单非空时只放行名单里的；
 * 名单为空时看 allowAllWhenEmpty。
 *
 * owner 的私聊永远放行：管理命令只能从那里触发，
 * 拒绝名单里写了 owner 会在配置解析时豁免并告警。
 */
export function isTargetAllowed(
  access: AccessConfig,
  target: ChatTarget,
  ownerQQ?: number,
): boolean {
  if (target.kind === "private" && ownerQQ !== undefined && target.id === ownerQQ) return true
  if (listFor(access.deny, target.kind).includes(target.id)) return false
  const allow = listFor(access.allow, target.kind)
  if (allow.length > 0) return allow.includes(target.id)
  return access.allowAllWhenEmpty
}

/**
 * 配置里明确放行的目标。
 *
 * allowAllWhenEmpty 打开时无法枚举没写进名单的目标，这里只列配置里写明的。
 */
export function allowedTargets(access: AccessConfig, ownerQQ?: number): ChatTarget[] {
  const candidates: ChatTarget[] = [
    ...access.allow.groups.map((id): ChatTarget => ({ kind: "group", id })),
    ...access.allow.users.map((id): ChatTarget => ({ kind: "private", id })),
  ]
  if (
    ownerQQ !== undefined &&
    !candidates.some((item) => item.kind === "private" && item.id === ownerQQ)
  ) {
    candidates.push({ kind: "private", id: ownerQQ })
  }
  return candidates.filter((target) => isTargetAllowed(access, target, ownerQQ))
}

/** 命令结果的投递目标：优先会话绑定的目标，没有就用第一个放行目标。 */
export function commandTarget(
  access: AccessConfig,
  ownerQQ: number | undefined,
  bound: ChatTarget | undefined,
): ChatTarget | undefined {
  if (bound && isTargetAllowed(access, bound, ownerQQ)) return bound
  return allowedTargets(access, ownerQQ)[0]
}
