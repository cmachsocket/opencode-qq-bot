import os from "node:os"
import path from "node:path"
import lockfile from "@bybrave/proper-lockfile2"

/** 机器人连接的机器级锁。 */
export interface BotLock {
  /** 释放锁；必须等待完成，确保底层句柄真正关闭。 */
  release(): Promise<void>
}

/** 机器级锁的可选参数。 */
export interface BotLockOptions {
  /** 心跳失效时回调：锁已无法保证独占，调用方必须停止消费消息。 */
  onCompromised?: (error: Error) => void
}

/**
 * 锁的过期时间：超过这么久没有心跳，锁可被其他进程接管。
 *
 * 插件与 OpenCode 同进程，事件循环被长任务阻塞时心跳会延迟，
 * 窗口太小会把"机器繁忙"误判成"锁失效"，白白停掉消息消费。
 */
const STALE_MS = 120_000
/** 心跳间隔：必须明显小于过期时间，避免机器繁忙时被误判为失效。 */
const UPDATE_MS = 30_000

/**
 * 锁目录路径。
 *
 * 同一台机器只允许一个插件实例，锁不按机器人身份区分：
 * 目录本身就是互斥凭据，库用原子 `mkdir` 抢占，心跳刷新目录的修改时间。
 */
export function botLockPath(): string {
  return path.join(os.tmpdir(), "opencode-qq-bot.lock")
}

/**
 * 独占一台机器上的插件实例。
 *
 * 同一台机器上可能有多个 OpenCode 实例加载插件（不同进程或不同工作区），
 * 每个实例都会向 NapCat 建立反向 WebSocket，而 NapCat 会把同一条消息推给
 * 所有连接，导致同一条 QQ 消息被重复投递给模型。这里做跨进程互斥，保证
 * 同一时间只有一个实例消费消息流。
 *
 * 锁基于文件系统，Windows、macOS、Linux 行为一致。持锁进程崩溃后，锁目录
 * 会在 `STALE_MS` 内过期并被接管，不会永久卡死。
 *
 * @param options 可选参数，`onCompromised` 用于感知心跳失效。
 * @returns 取得锁时返回释放句柄，已被占用时返回 undefined。
 */
export async function acquireBotLock(options: BotLockOptions = {}): Promise<BotLock | undefined> {
  const lockPath = botLockPath()
  try {
    const release = await lockfile.lock(lockPath, {
      lockfilePath: lockPath,
      // 目标文件并不存在，只要锁目录即可，不需要解析真实路径。
      realpath: false,
      stale: STALE_MS,
      update: UPDATE_MS,
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
