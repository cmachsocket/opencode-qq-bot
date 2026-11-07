/**
 * 进程内单实例注册表。
 *
 * 同一台机器上只允许一个插件实例：OpenCode 可能为不同项目目录加载插件，
 * 新实例会接管旧实例并让旧实例整体卸载，避免同时存在多条 NapCat 连接
 * 与重复的消息处理。注册表挂在 globalThis 上，模块重载后依然有效。
 *
 * 槽位绑定到机器人固定的工作目录：只有同一目录的实例才能互相接管，
 * 否则会话上下文会落在不同项目里。
 */

export interface PluginInstance {
  dispose?: () => Promise<void>
  /** 实例来源描述，仅用于日志。 */
  label?: string
}

export interface InstanceLease {
  /** Registers the cleanup used when a newer instance takes over or the plugin unloads. */
  setDispose(dispose: () => Promise<void>): void
  /** Clears the slot only when this lease still owns it. */
  release(): void
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
 * 占用进程内唯一的实例槽位。
 *
 * @param directory 机器人固定服务的工作目录。
 * @param label 实例来源描述，通常是项目目录与 NapCat 地址，仅用于日志。
 */
export function claimInstance(directory: string, label: string): InstanceClaim {
  const state = host()
  const active = state.active
  if (active && active.directory !== directory) {
    return { occupied: active.directory, lease: { setDispose() {}, release() {} } }
  }
  const instance: PluginInstance = { label }
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
    },
  }
}
