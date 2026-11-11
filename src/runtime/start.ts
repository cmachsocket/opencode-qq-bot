/**
 * 运行时启动状态机。
 *
 * 只有全部步骤成功才算启动完成：中途失败时下一次接管会重新搭一遍，
 * 而且失败必须把机器锁放掉，否则别的实例永远接不了手。
 */
export class RuntimeStart {
  private started = false
  private starting: Promise<void> | undefined

  constructor(
    private readonly options: {
      /** 能不能启动：卸载已经开始时返回 false。 */
      canStart: () => boolean
      /** 搭建运行时：工具、钩子与 NapCat 连接都在这一步。 */
      setup: () => Promise<void>
      /** 启动失败时的补救：释放机器锁。 */
      onFailure: (error: unknown) => Promise<void> | void
    },
  ) {}

  /** 已经启动完成。 */
  get isStarted(): boolean {
    return this.started
  }

  /** 正在启动中。 */
  get isStarting(): boolean {
    return this.starting !== undefined
  }

  /**
   * 启动运行时。
   *
   * 并发调用共享同一次启动；失败时把错误原样抛出去，由调用方决定是重试还是退出。
   */
  async run(): Promise<void> {
    if (this.started) return
    if (this.starting) return this.starting
    if (!this.options.canStart()) return
    this.starting = (async () => {
      try {
        await this.options.setup()
        this.started = true
      } catch (error) {
        // 启动失败还占着锁的话，别的实例永远接不了手；先补救再往上抛。
        await this.options.onFailure(error)
        throw error
      }
    })().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }
}
