import { describe, expect, it } from "vitest"
import { claimInstance, type PluginInstance } from "../src/instance"

let sequence = 0
const nextLabel = () => `project-${process.pid}-${sequence++}`
const home = "/work/qq-bot"

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
