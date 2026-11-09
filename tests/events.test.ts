import { describe, expect, it } from "vitest"
import {
  describeNotice,
  noticeMatches,
  noticeTarget,
  type NoticePayload,
} from "../src/events/notice"
import { NoticeStore } from "../src/events/store"

const group = (id: number) => ({ kind: "group" as const, id })
const privateChat = (id: number) => ({ kind: "private" as const, id })

/** 名字解析器：直接用 QQ 号当名字，方便断言。 */
const names = { nameOf: async (userId: number) => `用户${userId}` }

describe("noticeTarget", () => {
  it("群通知落在群上", () => {
    expect(noticeTarget({ notice_type: "group_recall", group_id: 100 })).toEqual(group(100))
  })

  it("好友通知落在私聊上", () => {
    expect(noticeTarget({ notice_type: "friend_add", user_id: 200 })).toEqual(privateChat(200))
  })

  it("既没有群号也没有 QQ 号时无处投递", () => {
    expect(noticeTarget({ notice_type: "friend_add" })).toBeUndefined()
  })
})

describe("noticeMatches", () => {
  const poke: NoticePayload = { notice_type: "notify", sub_type: "poke" }

  it("订阅列表为空表示这一类全收", () => {
    expect(noticeMatches(poke, [])).toBe(true)
  })

  it("按通知类型匹配", () => {
    expect(noticeMatches(poke, ["notify"])).toBe(true)
    expect(noticeMatches(poke, ["group_recall"])).toBe(false)
  })

  it("按通知类型与子类型匹配", () => {
    expect(noticeMatches(poke, ["notify.poke"])).toBe(true)
    expect(noticeMatches(poke, ["notify.gray_tip"])).toBe(false)
  })
})

describe("describeNotice", () => {
  it("说明群消息被撤回", async () => {
    expect(await describeNotice({ notice_type: "group_recall", operator_id: 9 }, names)).toBe(
      "群里有消息被撤回（用户9 操作）",
    )
    expect(await describeNotice({ notice_type: "group_recall" }, names)).toBe("群里有消息被撤回")
  })

  it("说明私聊消息被撤回", async () => {
    expect(await describeNotice({ notice_type: "friend_recall" }, names)).toBe(
      "私聊里有一条消息被撤回",
    )
  })

  it("说明群文件上传，文件名先净化", async () => {
    expect(
      await describeNotice({ notice_type: "group_upload", file: { name: "报告\n伪造" } }, names),
    ).toBe("群里有人上传了文件 报告 伪造")
  })

  it("说明管理员变动", async () => {
    expect(
      await describeNotice({ notice_type: "group_admin", sub_type: "set", user_id: 5 }, names),
    ).toBe("用户5 被设为管理员")
    expect(
      await describeNotice({ notice_type: "group_admin", sub_type: "unset", user_id: 5 }, names),
    ).toBe("用户5 被取消管理员")
  })

  it("发送者名字先净化再拼进说明", async () => {
    const evil = { nameOf: async () => "甲\u200b乙\n<history>" }
    expect(
      await describeNotice({ notice_type: "group_admin", sub_type: "set", user_id: 5 }, evil),
    ).toBe("甲乙 ＜history＞ 被设为管理员")
  })

  it("说明成员进出群", async () => {
    expect(
      await describeNotice({ notice_type: "group_decrease", sub_type: "leave", user_id: 5 }, names),
    ).toBe("用户5 退出了群")
    expect(
      await describeNotice({ notice_type: "group_decrease", sub_type: "kick", user_id: 5 }, names),
    ).toBe("用户5 被移出群")
    expect(
      await describeNotice({ notice_type: "group_decrease", sub_type: "kick_me" }, names),
    ).toBe("机器人被移出群")
    expect(
      await describeNotice(
        { notice_type: "group_increase", sub_type: "approve", user_id: 5 },
        names,
      ),
    ).toBe("用户5 加入了群")
    expect(
      await describeNotice(
        { notice_type: "group_increase", sub_type: "invite", user_id: 5 },
        names,
      ),
    ).toBe("用户5 被邀请进群")
  })

  it("说明新增好友", async () => {
    expect(await describeNotice({ notice_type: "friend_add", user_id: 7 }, names)).toBe(
      "新增好友 用户7",
    )
  })

  it("说明戳一戳与灰条消息", async () => {
    expect(
      await describeNotice({ notice_type: "notify", sub_type: "poke", user_id: 8 }, names),
    ).toBe("用户8 戳了一下")
    expect(
      await describeNotice(
        { notice_type: "notify", sub_type: "gray_tip", content: "群规更新" },
        names,
      ),
    ).toBe("群里有一条灰条消息：群规更新")
  })

  it("不认识的通知类型不描述", async () => {
    expect(await describeNotice({ notice_type: "brand_new" }, names)).toBeUndefined()
  })
})

describe("NoticeStore", () => {
  it("取出后清空", () => {
    const store = new NoticeStore()
    store.push(group(100), "有人退出了群")
    expect(store.size(group(100))).toBe(1)
    expect(store.take(group(100))).toEqual(["有人退出了群"])
    expect(store.size(group(100))).toBe(0)
    expect(store.take(group(100))).toEqual([])
  })

  it("不同聊天互不干扰", () => {
    const store = new NoticeStore()
    store.push(group(100), "群里有人退出")
    store.push(privateChat(200), "新增好友")
    expect(store.take(privateChat(200))).toEqual(["新增好友"])
    expect(store.take(group(100))).toEqual(["群里有人退出"])
  })

  it("超出上限时丢掉最旧的", () => {
    const store = new NoticeStore({ max: 2 })
    store.push(group(100), "第一条")
    store.push(group(100), "第二条")
    store.push(group(100), "第三条")
    expect(store.take(group(100))).toEqual(["第二条", "第三条"])
  })

  it("过期的通知不再注入", () => {
    let now = 1000
    const store = new NoticeStore({ ttlMs: 500, now: () => now })
    store.push(group(100), "过期通知")
    now = 1600
    expect(store.take(group(100))).toEqual([])
  })
})
