/**
 * 插件卸载流程。
 *
 * 卸载由一串步骤组成：停心跳、注销钩子、断开 NapCat、释放机器级锁。
 * 每一步都可能失败，而失败不能挡住后面的步骤——尤其是断开 NapCat 与
 * 释放机器级锁这两步：漏掉前者会留下重复投递的窗口，漏掉后者会留下
 * 残留的锁目录，直到过期窗口过去才有别的实例能接管。
 */

/** 卸载步骤。 */
export interface UnloadStep {
  /** 步骤名称，失败时写进日志。 */
  readonly name: string
  /** 步骤动作。 */
  readonly run: () => Promise<void> | void
}

/** 记录失败所需的最小日志接口。 */
export interface UnloadLogger {
  error(message: string, ...meta: unknown[]): void
}

/**
 * 依次执行卸载步骤。
 *
 * 单步失败只记日志并继续，保证后面的步骤一定会执行。
 *
 * @param steps 卸载步骤，按给定顺序执行。
 * @param logger 日志器，用来记录失败。
 */
export async function runUnload(steps: readonly UnloadStep[], logger: UnloadLogger): Promise<void> {
  for (const step of steps) {
    try {
      await step.run()
    } catch (error) {
      logger.error(`卸载步骤失败：${step.name}`, error)
    }
  }
}
