import { runUnload, type UnloadLogger, type UnloadStep } from "./unload"

/**
 * 卸载步骤的执行顺序。
 *
 * 数字小的先执行。交接在途状态必须最先做，接管方才能拿到上一轮的状态；
 * 断开 NapCat 必须早于释放机器级锁，避免新实例接管时出现两条连接。
 */
export const CleanupOrder = {
  handover: 10,
  keepAlive: 20,
  events: 30,
  manager: 40,
  persist: 50,
  souls: 60,
  tools: 70,
  tui: 80,
  labeler: 90,
  guards: 100,
  hooks: 110,
  napcat: 120,
  lock: 130,
  lease: 140,
  logs: 150,
} as const

/**
 * 卸载步骤的收集器。
 *
 * 插件初始化要花一小段时间，这期间新实例可能已经加载并要求旧实例卸载。
 * 清理函数必须那时就已经可用，所以每建好一样资源就登记一步，
 * 而不是等初始化结束再拼一个固定的步骤列表。
 */
export class Cleanup {
  private readonly steps: Array<UnloadStep & { order: number }> = []
  private started = false

  /**
   * 登记一步清理。
   *
   * @param name 步骤名称，失败时写进日志。
   * @param run 步骤动作。
   * @param order 执行顺序，数字小的先执行。
   */
  add(name: string, run: () => Promise<void> | void, order: number): void {
    // 清理已经跑完又登记了新步骤：这一步当场释放，别把资源留在原地。
    if (this.started) {
      void Promise.resolve()
        .then(run)
        .catch(() => {})
      return
    }
    this.steps.push({ name, run, order })
  }

  /** 是否已经执行过。 */
  get done(): boolean {
    return this.started
  }

  /**
   * 执行全部清理。
   *
   * 每一步单独兜底：一步失败不能挡住后面的步骤。
   *
   * @param logger 日志器，用来记录失败。
   */
  async run(logger: UnloadLogger): Promise<void> {
    if (this.started) return
    this.started = true
    const steps = [...this.steps].sort((left, right) => left.order - right.order)
    await runUnload(steps, logger)
  }
}
