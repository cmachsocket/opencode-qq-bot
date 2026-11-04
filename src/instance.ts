/**
 * Cross-reload singleton registry.
 *
 * OpenCode may load a plugin again without invoking the previous instance's
 * cleanup, which would leave duplicate WebSocket connections and duplicate
 * message handlers behind. The registry lives on globalThis so it survives
 * module reloads within the same server process.
 */

export interface PluginInstance {
  dispose?: () => Promise<void>
}

export interface InstanceLease {
  /** Registers the cleanup used when a newer instance takes over or the plugin unloads. */
  setDispose(dispose: () => Promise<void>): void
  /** Clears the slot only when this lease still owns it. */
  release(): void
}

interface Host {
  active?: { key: string; instance: PluginInstance }
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
 * Claims the singleton slot for `key` and returns any previous instance with
 * the same key so the caller can dispose it. Instances with different keys
 * (for example another project) are left untouched.
 */
export function claimInstance(key: string): {
  previous: PluginInstance | undefined
  lease: InstanceLease
} {
  const state = host()
  const previous = state.active?.key === key ? state.active.instance : undefined
  const instance: PluginInstance = {}
  state.active = { key, instance }
  return {
    previous,
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
