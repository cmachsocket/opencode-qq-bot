import lockfile from "@bybrave/proper-lockfile2"

/**
 * 共享会话状态的跨进程写锁。
 *
 * 插件存储是全机器共享的：两个实例同时读-改-写同一张表时，
 * 后写的会拿自己的旧视图覆盖先写的。这里用文件锁把读-改-写串成一段临界区。
 *
 * 锁没有「持有上限」：临界区多长都能继续写。锁被抢走时通过 `onCompromised` 报出来，
 * 调用方要处理这个信号，不要当成没发生。
 */

/**
 * 锁的过期时间：超过这么久没有心跳，锁可被其他进程接管。
 *
 * 临界区只有几次存储读写，正常情况下毫秒级完成；
 * 窗口取大一些，避免事件循环被长任务阻塞、或者进程被 suspend 时误判成锁失效
 * ——误判会让两个进程同时写同一张表。
 */
const STALE_MS = 120_000
/** 心跳间隔：必须明显小于过期时间。 */
const UPDATE_MS = 30_000

/** 写锁句柄。 */
export interface StateLock {
  /** 释放锁；必须等待完成，确保锁目录真正清掉。 */
  release(): Promise<void>
}

/** 取锁的可选参数。 */
export interface StateLockOptions {
  /** 抢不到锁时的重试参数。 */
  retries?: { retries?: number; factor?: number; minTimeout?: number; maxTimeout?: number }
  /** 心跳失效时回调：锁已无法保证独占。 */
  onCompromised?: (error: Error) => void
}

/**
 * 拿到共享状态的写锁。
 *
 * @param lockPath 锁路径，锁目录建在这里，父目录必须已经存在。
 * @param options 可选参数，`retries` 决定抢不到锁时等多久。
 * @returns 拿到锁时返回句柄，被占用且重试用尽时返回 undefined。
 */
export async function acquireStateLock(
  lockPath: string,
  options: StateLockOptions = {},
): Promise<StateLock | undefined> {
  try {
    const release = await lockfile.lock(lockPath, {
      lockfilePath: lockPath,
      // 目标文件并不存在，只要锁目录即可，不需要解析真实路径。
      realpath: false,
      stale: STALE_MS,
      update: UPDATE_MS,
      retries: options.retries ?? 0,
      onCompromised: (error) => options.onCompromised?.(error),
    })
    return {
      release: async () => {
        try {
          await release()
        } catch (error) {
          // 锁已经失效时释放会报 ERELEASED，锁目录由接管方清理。
          if ((error as NodeJS.ErrnoException).code !== "ERELEASED") throw error
        }
      },
    }
  } catch (error) {
    // 锁被占用是正常情况，其它错误交给调用方处理。
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") return undefined
    throw error
  }
}
