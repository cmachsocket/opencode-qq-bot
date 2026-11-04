import { describe, expect, it } from "vitest"
import { claimInstance, type PluginInstance } from "../src/instance"

let sequence = 0
const nextKey = () => `test-${process.pid}-${sequence++}`

describe("claimInstance", () => {
  it("returns the previous instance for the same key", () => {
    const key = nextKey()
    const first = claimInstance(key)
    expect(first.previous).toBeUndefined()

    const second = claimInstance(key)
    expect(second.previous).toBeDefined()
    second.lease.release()
  })

  it("disposes different keys independently", () => {
    const first = claimInstance(nextKey())
    const second = claimInstance(nextKey())
    expect(first.previous).toBeUndefined()
    expect(second.previous).toBeUndefined()
    first.lease.release()
    second.lease.release()
  })

  it("only releases the slot owned by the lease", async () => {
    const key = nextKey()
    let disposed = 0
    const first = claimInstance(key)
    const second = claimInstance(key)
    second.lease.setDispose(async () => {
      disposed += 1
    })

    first.lease.release()
    const third = claimInstance(key)
    expect(third.previous).toBeDefined()
    await third.previous?.dispose?.()
    expect(disposed).toBe(1)

    second.lease.release()
    third.lease.release()
  })

  it("registers the cleanup on the claimed instance", async () => {
    const key = nextKey()
    let disposed = 0
    const first = claimInstance(key)
    first.lease.setDispose(async () => {
      disposed += 1
    })

    const second = claimInstance(key)
    const previous = second.previous as PluginInstance
    await previous.dispose?.()
    expect(disposed).toBe(1)

    second.lease.release()
  })

  it("clears the slot after the current lease releases", () => {
    const key = nextKey()
    const first = claimInstance(key)
    first.lease.release()

    const second = claimInstance(key)
    expect(second.previous).toBeUndefined()
    second.lease.release()
  })
})
