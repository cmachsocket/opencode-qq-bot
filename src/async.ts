/** 定时器句柄：Node/Bun 的定时器带 unref，但类型未必声明了。 */
interface TimerHandle {
  unref?: () => void
}

/**
 * 让定时器不挂住事件循环。
 *
 * 插件里的定时器都只是兜底轮询，进程没有它们也该能正常退出。
 */
export function unrefTimer(handle: TimerHandle): void {
  handle.unref?.()
}

/**
 * 等待一段时间。
 *
 * 定时器不挂住事件循环：等待期间进程没有别的事要做，可以直接退出，
 * 不会因为一次重试或一段发送间隔把进程拖住。
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    unrefTimer(setTimeout(resolve, ms))
  })
}
