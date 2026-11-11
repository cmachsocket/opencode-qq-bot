import { unrefTimer } from "../async"

export interface ClaimTimerOptions {
  /** 重试间隔。 */
  intervalMs: number
  /** 现在要不要试：已经拿到锁就不必再试。 */
  shouldTry: () => boolean
  /** 尝试抢占机器锁；返回 true 表示抢到了。 */
  claim: () => Promise<boolean>
  /** 抢到锁之后搭运行时。 */
  onClaimed: () => Promise<void>
  /** 出错时的处理。 */
  onError: (error: unknown) => void
}

/**
 * 启动接管重试定时器。
 *
 * 装上它就意味着后面还有重试的机会：首次初始化失败时靠它再搭一次，
 * 所以它必须先于第一次抢锁装好。
 */
export function startClaimTimer(options: ClaimTimerOptions): { stop: () => void } {
  const timer = setInterval(() => {
    if (!options.shouldTry()) return
    void options
      .claim()
      .then(async (ok) => {
        if (!ok) return
        await options.onClaimed()
      })
      .catch((error: unknown) => options.onError(error))
  }, options.intervalMs)
  unrefTimer(timer)
  return {
    stop: () => clearInterval(timer),
  }
}
