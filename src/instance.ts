/**
 * 进程内单实例注册表。
 *
 * 同一台机器上只允许一个插件实例：OpenCode 可能为不同项目目录加载插件，
 * 新实例会接管旧实例并让旧实例整体卸载，避免同时存在多条 NapCat 连接
 * 与重复的消息处理。注册表挂在 globalThis 上，模块重载后依然有效。
 *
 * 槽位绑定到机器人固定的工作目录：只有同一目录的实例才能互相接管，
 * 否则会话上下文会落在不同项目里。
 *
 * 接管时旧实例把在途状态留在注册表里，新实例取走并继续，
 * 免得正在跑的那一轮在上游白跑、回复丢掉。
 */

import type { HandoverState } from "./session/manager"

export interface PluginInstance {
  dispose?: () => Promise<void>
  /** 实例来源描述，仅用于日志。 */
  label?: string
  /** 初始化完成的信号；初始化还没结束时，接管方靠它等待。 */
  ready?: Promise<void>
}

export interface InstanceLease {
  /** Registers the cleanup used when a newer instance takes over or the plugin unloads. */
  setDispose(dispose: () => Promise<void>): void
  /** Clears the slot only when this lease still owns it. */
  release(): void
  /** 本实例是否已经被更新的实例接管。 */
  superseded(): boolean
  /** 标记初始化完成，接管方不必再等。 */
  markReady(): void
  /**
   * 把在途状态留给接管本实例的新实例。
   *
   * 只有真的被接管时才留：正常卸载没有接手方，留着也没用。
   */
  handover(states: readonly HandoverState[]): void
}

export interface InstanceClaim {
  /** 同一工作目录下被接管的旧实例。 */
  previous?: PluginInstance
  /** 槽位已被其它工作目录占用时给出该目录，调用方应停止运行。 */
  occupied?: string
  lease: InstanceLease
}

interface Host {
  active?: { directory: string; instance: PluginInstance }
  /** 上一实例留下的在途状态，由接管它的新实例取走。 */
  handover?: HandoverState[]
}

const HOST_KEY = "__opencodeQQBotHost__"

function host(): Host {
  const global = globalThis as Record<string, unknown>
  const existing = global[HOST_KEY]
  if (existing && typeof existing === "object") return existing as Host
  const created: Host = {}
  global[HOST_KEY] = created
  return created
}

/**
 * 取走上一实例留下的在途状态。
 *
 * 取走即清空，避免陈旧的状态被后来的实例误当成自己的。
 */
export function takeHandover(): HandoverState[] {
  const state = host()
  const handover = state.handover ?? []
  state.handover = undefined
  return handover
}

/**
 * 卸载上一个实例。
 *
 * 上一个实例可能还在初始化：它的清理函数要等初始化结束才注册，
 * 这里先等它的初始化信号，再执行卸载。等不到就放弃，由它自己退出。
 *
 * @returns 是否真的卸载了。
 */
export async function disposePrevious(previous: PluginInstance, waitMs = 10_000): Promise<boolean> {
  if (!previous.dispose) {
    const timer = new Promise<undefined>((resolve) => {
      const handle = setTimeout(resolve, waitMs)
      handle.unref?.()
    })
    await Promise.race([previous.ready, timer])
  }
  if (!previous.dispose) return false
  await previous.dispose()
  return true
}

/**
 * 占用进程内唯一的实例槽位。
 *
 * @param directory 机器人固定服务的工作目录。
 * @param label 实例来源描述，通常是项目目录与 NapCat 地址，仅用于日志。
 */
export function claimInstance(directory: string, label: string): InstanceClaim {
  const state = host()
  const active = state.active
  if (active && active.directory !== directory) {
    return {
      occupied: active.directory,
      lease: {
        setDispose() {},
        release() {},
        markReady() {},
        superseded() {
          return false
        },
        handover() {},
      },
    }
  }
  const instance: PluginInstance = { label }
  // 初始化完成的信号：新实例接管时，上一个实例可能还没准备好卸载函数。
  let markReady!: () => void
  instance.ready = new Promise<void>((resolve) => {
    markReady = resolve
  })
  state.active = { directory, instance }
  return {
    previous: active?.instance,
    lease: {
      setDispose(dispose) {
        instance.dispose = dispose
      },
      release() {
        if (state.active?.instance === instance) state.active = undefined
      },
      markReady() {
        markReady()
      },
      superseded() {
        const active = state.active
        return active !== undefined && active.instance !== instance
      },
      handover(states) {
        // 已经有新实例接管时，这轮状态留给它；正常卸载没有接手方，留着也没用。
        const active = state.active
        if (!active || active.instance === instance) return
        // 空状态不用覆盖：前面可能有别的实例已经留下了要交接的东西。
        if (states.length === 0) return
        state.handover = [...(state.handover ?? []), ...states]
      },
    },
  }
}
