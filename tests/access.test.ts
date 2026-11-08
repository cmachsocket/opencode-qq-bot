import { describe, expect, it } from "vitest"
import { allowedTargets, commandTarget, isTargetAllowed } from "../src/access"
import type { ChatTarget } from "../src/chat"
import { accessConfig } from "./fixtures"

const group = (id: number): ChatTarget => ({ kind: "group", id })
const privateChat = (id: number): ChatTarget => ({ kind: "private", id })

describe("isTargetAllowed", () => {
  it("放行名单里的目标", () => {
    const access = accessConfig({ groups: [100], users: [200] })
    expect(isTargetAllowed(access, group(100))).toBe(true)
    expect(isTargetAllowed(access, privateChat(200))).toBe(true)
    expect(isTargetAllowed(access, group(101))).toBe(false)
    expect(isTargetAllowed(access, privateChat(201))).toBe(false)
  })

  it("拒绝名单优先于放行名单", () => {
    const access = accessConfig(
      { groups: [100], users: [200] },
      { deny: { groups: [100], users: [200] } },
    )
    expect(isTargetAllowed(access, group(100))).toBe(false)
    expect(isTargetAllowed(access, privateChat(200))).toBe(false)
  })

  it("放行名单为空时按 allowAllWhenEmpty 决定", () => {
    const closed = accessConfig({})
    expect(isTargetAllowed(closed, group(100))).toBe(false)
    expect(isTargetAllowed(closed, privateChat(200))).toBe(false)

    const open = accessConfig({}, { allowAllWhenEmpty: true })
    expect(isTargetAllowed(open, group(100))).toBe(true)
    expect(isTargetAllowed(open, privateChat(200))).toBe(true)
  })

  it("拒绝名单在放行名单为空时仍然生效", () => {
    const access = accessConfig({}, { allowAllWhenEmpty: true, deny: { groups: [100], users: [] } })
    expect(isTargetAllowed(access, group(100))).toBe(false)
    expect(isTargetAllowed(access, group(101))).toBe(true)
  })

  it("owner 的私聊永远放行", () => {
    const access = accessConfig({}, { deny: { groups: [], users: [200] } })
    expect(isTargetAllowed(access, privateChat(200), 200)).toBe(true)
    expect(isTargetAllowed(access, privateChat(200), 300)).toBe(false)
  })

  it("没有配置 owner 时不豁免任何私聊", () => {
    const access = accessConfig({ users: [200] })
    expect(isTargetAllowed(access, privateChat(200), undefined)).toBe(true)
    expect(isTargetAllowed(access, privateChat(201), undefined)).toBe(false)
  })
})

describe("allowedTargets", () => {
  it("列出放行名单里的目标", () => {
    const access = accessConfig({ groups: [100], users: [200] })
    expect(allowedTargets(access)).toEqual([group(100), privateChat(200)])
  })

  it("把 owner 的私聊也算进去", () => {
    const access = accessConfig({ groups: [100] })
    expect(allowedTargets(access, 200)).toEqual([group(100), privateChat(200)])
  })

  it("跳过被拒绝的目标", () => {
    const access = accessConfig(
      { groups: [100], users: [200] },
      { deny: { groups: [100], users: [] } },
    )
    expect(allowedTargets(access)).toEqual([privateChat(200)])
  })

  it("名单为空时只列得出来的东西", () => {
    const access = accessConfig({}, { allowAllWhenEmpty: true })
    expect(allowedTargets(access)).toEqual([])
  })
})

describe("commandTarget", () => {
  it("优先用会话绑定的目标", () => {
    const access = accessConfig({ groups: [100], users: [200] })
    expect(commandTarget(access, undefined, group(100))).toEqual(group(100))
  })

  it("绑定的目标被拒绝时回退到第一个放行目标", () => {
    const access = accessConfig({ groups: [100] }, { deny: { groups: [200], users: [] } })
    expect(commandTarget(access, undefined, group(200))).toEqual(group(100))
  })

  it("没有任何放行目标时返回 undefined", () => {
    const access = accessConfig({})
    expect(commandTarget(access, undefined, undefined)).toBeUndefined()
  })

  it("没有绑定时用第一个放行目标", () => {
    const access = accessConfig({ groups: [100], users: [200] })
    expect(commandTarget(access, undefined, undefined)).toEqual(group(100))
  })
})
