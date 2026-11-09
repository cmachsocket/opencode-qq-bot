import { describe, expect, it } from "vitest"
import { claimInstance, takeHandover, type PluginInstance } from "../src/instance"
import type { HandoverState } from "../src/session/manager"

let sequence = 0
const nextLabel = () => `project-${process.pid}-${sequence++}`
const home = "/work/qq-bot"

const handoverState: HandoverState = {
  target: { kind: "group", id: 100 },
  sessionID: "session-1",
  awaitingSend: true,
  reminders: 0,
  lastDispatchAt: 1,
  idleAt: 0,
  buffer: [],
  pendingAttempts: 0,
}

describe("claimInstance", () => {
  it("returns the previous instance on the next claim", () => {
    const first = claimInstance(home, nextLabel())
    expect(first.previous).toBeUndefined()

    const second = claimInstance(home, nextLabel())
    expect(second.previous).toBeDefined()
    second.lease.release()
  })

  it("hands over instances loaded from another project directory", () => {
    const first = claimInstance(home, "project-a")
    expect(first.previous).toBeUndefined()

    const second = claimInstance(home, "project-b")
    expect(second.previous?.label).toBe("project-a")
    second.lease.release()
  })

  it("keeps the slot when the claimed working directory differs", () => {
    const first = claimInstance("/work/a", "project-a")
    const second = claimInstance("/work/b", "project-b")
    expect(second.occupied).toBe("/work/a")
    expect(second.previous).toBeUndefined()
    second.lease.release()

    const third = claimInstance("/work/a", "project-c")
    expect(third.previous?.label).toBe("project-a")
    third.lease.release()
    first.lease.release()
  })

  it("only releases the slot owned by the lease", async () => {
    let disposed = 0
    const first = claimInstance(home, nextLabel())
    const second = claimInstance(home, nextLabel())
    second.lease.setDispose(async () => {
      disposed += 1
    })

    first.lease.release()
    const third = claimInstance(home, nextLabel())
    expect(third.previous).toBeDefined()
    await third.previous?.dispose?.()
    expect(disposed).toBe(1)

    second.lease.release()
    third.lease.release()
  })

  it("registers the cleanup on the claimed instance", async () => {
    let disposed = 0
    const first = claimInstance(home, nextLabel())
    first.lease.setDispose(async () => {
      disposed += 1
    })

    const second = claimInstance(home, nextLabel())
    const previous = second.previous as PluginInstance
    await previous.dispose?.()
    expect(disposed).toBe(1)

    second.lease.release()
  })

  it("clears the slot after the current lease releases", () => {
    const first = claimInstance(home, nextLabel())
    first.lease.release()

    const second = claimInstance(home, nextLabel())
    expect(second.previous).toBeUndefined()
    second.lease.release()
  })
})

describe("实例交接", () => {
  it("判断自己是否已经被接管", () => {
    const first = claimInstance(home, nextLabel())
    expect(first.lease.superseded()).toBe(false)

    const second = claimInstance(home, nextLabel())
    expect(first.lease.superseded()).toBe(true)
    expect(second.lease.superseded()).toBe(false)

    second.lease.release()
  })

  it("正常卸载时不留在途状态", () => {
    const first = claimInstance(home, nextLabel())
    first.lease.handover([handoverState])
    expect(takeHandover()).toEqual([])
    first.lease.release()
  })

  it("被接管时把在途状态留给新实例", () => {
    const first = claimInstance(home, nextLabel())
    const second = claimInstance(home, nextLabel())
    expect(second.previous).toBeDefined()

    // 旧实例卸载时把还在跑的那一轮交出来。
    first.lease.handover([handoverState])
    expect(takeHandover()).toEqual([handoverState])
    // 取走即清空，后来的实例不会捡到陈旧的状态。
    expect(takeHandover()).toEqual([])

    second.lease.release()
  })

  it("空的交接不会覆盖已经留下的状态", () => {
    const first = claimInstance(home, nextLabel())
    const second = claimInstance(home, nextLabel())

    first.lease.handover([handoverState])
    // 第二个旧实例没有在途状态，不能把前面留下的那份清掉。
    second.lease.handover([])
    expect(takeHandover()).toEqual([handoverState])

    second.lease.release()
  })
})
