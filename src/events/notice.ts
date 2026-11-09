import type { ChatTarget } from "../chat"
import { sanitizeSenderName, sanitizeUntrustedText } from "../model-view"

/**
 * 插件消费的通负载。
 *
 * NapCat 各类通知的字段并不统一（撤回带 operator_id，进退群带 sub_type），
 * 这里只声明用得到的字段，缺的按缺省处理。
 */
export interface NoticePayload {
  notice_type: string
  sub_type?: string
  group_id?: number
  user_id?: number
  operator_id?: number
  target_id?: number
  message_id?: number
  content?: string
  file?: { name?: string; size?: number }
}

/** 插件认识的全部通知类型。 */
export const NOTICE_TYPES = [
  "group_recall",
  "friend_recall",
  "group_upload",
  "group_admin",
  "group_decrease",
  "group_increase",
  "friend_add",
  "notify",
] as const

export type NoticeType = (typeof NOTICE_TYPES)[number]

/** 通知类型是否受支持。 */
export function isNoticeType(value: string): value is NoticeType {
  return (NOTICE_TYPES as readonly string[]).includes(value)
}

/**
 * 通知对应的聊天目标。
 *
 * 群通知看 group_id，好友通知看 user_id；两者都没有就不知道该投递给谁。
 */
export function noticeTarget(event: NoticePayload): ChatTarget | undefined {
  if (typeof event.group_id === "number" && event.group_id > 0) {
    return { kind: "group", id: event.group_id }
  }
  if (typeof event.user_id === "number" && event.user_id > 0) {
    return { kind: "private", id: event.user_id }
  }
  return undefined
}

/**
 * 通知是否命中订阅列表。
 *
 * 列表为空表示这一类全收；否则 `notice_type` 或 `notice_type.sub_type` 命中即可。
 */
export function noticeMatches(event: NoticePayload, notices: readonly string[]): boolean {
  if (notices.length === 0) return true
  if (notices.includes(event.notice_type)) return true
  const sub = event.sub_type
  return (
    typeof sub === "string" && sub.length > 0 && notices.includes(`${event.notice_type}.${sub}`)
  )
}

/** 通知里出现的人名由外部提供。 */
export interface NoticeNames {
  /** 把 QQ 号解析成显示名；解析不到返回空串。 */
  nameOf: (userId: number) => Promise<string>
}

/**
 * 把通知写成一句中文描述。
 *
 * 撤回类通知不复述被撤回的内容：内容可能已经不该再出现在上下文里。
 * 外部文本（显示名、文件名、灰条内容）先净化再拼进描述。
 */
export async function describeNotice(
  event: NoticePayload,
  names: NoticeNames,
): Promise<string | undefined> {
  const nameOf = async (userId: number | undefined): Promise<string> => {
    if (typeof userId !== "number" || userId <= 0) return ""
    const name = await names.nameOf(userId)
    return name ? sanitizeSenderName(name) : ""
  }
  const withName = async (userId: number | undefined, text: string): Promise<string> => {
    const name = await nameOf(userId)
    if (!name) return text
    return text ? `${name} ${text}` : name
  }

  switch (event.notice_type) {
    case "group_recall": {
      const who = await nameOf(event.operator_id)
      return who ? `群里有消息被撤回（${who} 操作）` : "群里有消息被撤回"
    }
    case "friend_recall":
      return "私聊里有一条消息被撤回"
    case "group_upload": {
      const file = event.file?.name ? sanitizeUntrustedText(String(event.file.name)) : ""
      return file ? `群里有人上传了文件 ${file}` : "群里有人上传了文件"
    }
    case "group_admin": {
      const who = await withName(event.user_id, "")
      if (event.sub_type === "unset") return who ? `${who} 被取消管理员` : "有人被取消管理员"
      return who ? `${who} 被设为管理员` : "有人被设为管理员"
    }
    case "group_decrease": {
      if (event.sub_type === "kick_me") return "机器人被移出群"
      const who = await withName(event.user_id, "")
      if (event.sub_type === "leave") return who ? `${who} 退出了群` : "有人退出了群"
      return who ? `${who} 被移出群` : "有人被移出群"
    }
    case "group_increase": {
      const who = await withName(event.user_id, "")
      if (event.sub_type === "invite") return who ? `${who} 被邀请进群` : "有人被邀请进群"
      return who ? `${who} 加入了群` : "有人加入了群"
    }
    case "friend_add": {
      const who = await nameOf(event.user_id)
      return who ? `新增好友 ${who}` : "新增好友"
    }
    case "notify": {
      if (event.sub_type === "poke") return await withName(event.user_id, "戳了一下")
      if (event.sub_type === "gray_tip") {
        const content = event.content ? sanitizeUntrustedText(String(event.content)) : ""
        return content ? `群里有一条灰条消息：${content}` : "群里有一条灰条消息"
      }
      return undefined
    }
    default:
      return undefined
  }
}
