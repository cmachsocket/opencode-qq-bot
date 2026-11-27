/** 一次初始化产出的资源。 */
export interface SetupGeneration<T> {
  /** 卸载这一代。 */
  dispose: () => Promise<void>
  /** 跨重启保留的状态，交给下一次初始化。 */
  carry?: T
}

/**
 * 可重启的初始化。
 *
 * 重启时先完整卸载上一代，再用新配置重新跑一遍初始化；
 * 并发重启共享同一次执行，卸载会等待进行中的重启落定。
 */
export class RestartableSetup<T> {
  private current: SetupGeneration<T> | undefined
  private beginning: Promise<void> | undefined
  private restarting: Promise<void> | undefined
  private stopped = false

  constructor(private readonly start: (carry?: T) => Promise<SetupGeneration<T>>) {}

  /** 跑第一次初始化。 */
  async begin(): Promise<void> {
    this.beginning = (async () => {
      const generation = await this.start()
      if (this.stopped) {
        await generation.dispose()
        return
      }
      this.current = generation
    })()
    try {
      await this.beginning
    } finally {
      this.beginning = undefined
    }
  }

  /** 重新初始化；并发调用共享同一次重启。 */
  restart(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.restarting) return this.restarting
    this.restarting = (async () => {
      // 第一次初始化还没落定时先等它，避免两代同时跑起来。
      if (this.beginning) await this.beginning
      if (this.stopped) return
      const previous = this.current
      this.current = undefined
      await previous?.dispose()
      if (this.stopped) return
      const next = await this.start(previous?.carry)
      if (this.stopped) {
        await next.dispose()
        return
      }
      this.current = next
    })().finally(() => {
      this.restarting = undefined
    })
    return this.restarting
  }

  /** 停止并卸载当前一代；会等待进行中的初始化和重启落定。 */
  async dispose(): Promise<void> {
    this.stopped = true
    if (this.beginning) await this.beginning.catch(() => {})
    const pending = this.restarting
    if (pending) await pending.catch(() => {})
    const current = this.current
    this.current = undefined
    await current?.dispose()
  }
}
