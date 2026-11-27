import { describe, expect, it } from "vitest"
import { RestartableSetup } from "../src/restartable"

describe("RestartableSetup", () => {
  it("先卸载上一代，再把 carry 交给新一代", async () => {
    const events: string[] = []
    let generation = 0
    const setup = new RestartableSetup<{ id: number }>(async (carry) => {
      generation += 1
      const id = generation
      events.push(`start:${id}:${carry?.id ?? "none"}`)
      return {
        carry: { id },
        dispose: async () => {
          events.push(`dispose:${id}`)
        },
      }
    })

    await setup.begin()
    await setup.restart()
    await setup.dispose()

    expect(events).toEqual(["start:1:none", "dispose:1", "start:2:1", "dispose:2"])
  })

  it("并发重启共享同一次执行", async () => {
    let starts = 0
    const setup = new RestartableSetup<number>(async () => {
      starts += 1
      return { carry: starts, dispose: async () => {} }
    })

    await setup.begin()
    const first = setup.restart()
    const second = setup.restart()
    expect(first).toBe(second)
    await first
    expect(starts).toBe(2)
  })

  it("第一次初始化未完成时，重启会等它落定", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let starts = 0
    const setup = new RestartableSetup<number>(async () => {
      starts += 1
      if (starts === 1) await gate
      return { dispose: async () => {} }
    })

    const beginning = setup.begin()
    const restarting = setup.restart()
    await Promise.resolve()
    expect(starts).toBe(1)
    release()
    await beginning
    await restarting
    expect(starts).toBe(2)
    await setup.dispose()
  })

  it("卸载会等待进行中的重启，并把新一代也卸掉", async () => {
    let release!: () => void
    let started!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const starting = new Promise<void>((resolve) => {
      started = resolve
    })
    const disposed: number[] = []
    let generation = 0
    const setup = new RestartableSetup<number>(async () => {
      generation += 1
      const id = generation
      if (id === 2) {
        started()
        await blocked
      }
      return {
        dispose: async () => {
          disposed.push(id)
        },
      }
    })

    await setup.begin()
    void setup.restart()
    await starting
    const disposing = setup.dispose()
    release()
    await disposing

    expect(disposed).toEqual([1, 2])
  })

  it("重启失败后还能再次重启", async () => {
    let generation = 0
    const setup = new RestartableSetup<number>(async () => {
      generation += 1
      if (generation === 2) throw new Error("boom")
      return { carry: generation, dispose: async () => {} }
    })

    await setup.begin()
    await expect(setup.restart()).rejects.toThrow("boom")
    await expect(setup.restart()).resolves.toBeUndefined()
    expect(generation).toBe(3)
  })

  it("卸载之后重启是空操作", async () => {
    let starts = 0
    const setup = new RestartableSetup<number>(async () => {
      starts += 1
      return { dispose: async () => {} }
    })

    await setup.begin()
    await setup.dispose()
    await setup.restart()
    expect(starts).toBe(1)
  })
})
