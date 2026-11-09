import { readFile, rename, rm, stat, writeFile } from "node:fs/promises"
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
/** 锁目录旁的宿主进程记录，用来在崩溃后立刻判断持有者是否还活着。 */
const OWNER_SUFFIX = ".owner"
/** 刚建立的锁先按过期处理，给持有者写完归属文件的时间。 */
const TAKEOVER_GRACE_MS = 10_000

/**
 * 锁目录路径。
 *
 * 同一台机器只允许一个插件实例，锁不按机器人身份区分：
 * 目录本身就是互斥凭据，库用原子 `mkdir` 抢占，心跳刷新目录的修改时间。
 */
export function botLockPath(): string {
  return path.join(os.tmpdir(), "opencode-qq-bot.lock")
}

interface LockOwner {
  pid: number
}

function ownerPath(lockPath: string): string {
  return `${lockPath}${OWNER_SUFFIX}`
}

/** 读取持锁进程；文件缺失或损坏时返回 undefined。 */
async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const raw = JSON.parse(await readFile(ownerPath(lockPath), "utf8")) as { pid?: unknown }
    const pid = Number(raw.pid)
    return Number.isInteger(pid) && pid > 0 ? { pid } : undefined
  } catch {
    return undefined
  }
}

/** 记录持锁进程；只是加速崩溃接管，写失败不影响正常加锁。 */
async function writeOwner(lockPath: string): Promise<void> {
  try {
    await writeFile(ownerPath(lockPath), JSON.stringify({ pid: process.pid }), "utf8")
  } catch {
    // 归属信息写不进去时退回过期接管。
  }
}

/** 释放前清掉自己的归属文件，别让下一个持有者误读。 */
async function clearOwner(lockPath: string): Promise<void> {
  const source = ownerPath(lockPath)
  const temp = `${source}.${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  try {
    await rename(source, temp)
  } catch {
    return
  }
  try {
    const owner = JSON.parse(await readFile(temp, "utf8")) as { pid?: unknown }
    if (Number(owner.pid) !== process.pid) {
      await rename(temp, source).catch(() => {})
      return
    }
    await rm(temp, { force: true })
  } catch {
    await rm(temp, { force: true }).catch(() => {})
  }
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 说明进程存在但没权限发信号，仍然算活着。
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * 立刻接管崩溃进程留下的锁。
 *
 * 只按 PID 判断，不缩短心跳过期时间：事件循环被长任务阻塞时，
 * 缩短过期窗口会让正常实例被误判为失效。目录刚建立时不抢，
 * 留出持锁方写归属文件的时间。
 */
async function reclaimDeadLock(lockPath: string): Promise<boolean> {
  let before
  try {
    before = await stat(lockPath)
  } catch {
    return false
  }
  if (Date.now() - before.mtimeMs < TAKEOVER_GRACE_MS) return false
  const owner = await readOwner(lockPath)
  if (!owner || processAlive(owner.pid)) return false
  const claimPath = `${lockPath}.dead-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  try {
    await rename(lockPath, claimPath)
  } catch (error) {
    // 别的实例已经清掉，直接重试抢锁。
    return (error as NodeJS.ErrnoException).code === "ENOENT"
  }
  try {
    // 和库的过期接管一样核对修改时间：拿到的不是刚才看到的那个锁就还回去。
    const claimed = await stat(claimPath)
    if (claimed.mtimeMs !== before.mtimeMs) {
      await rename(claimPath, lockPath).catch(() => {})
      return false
    }
    await rm(claimPath, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 独占一台机器上的插件实例。
 *
 * 同一台机器上可能有多个 OpenCode 实例加载插件（不同进程或不同工作区），
 * 每个实例都会向 NapCat 建立反向 WebSocket，而 NapCat 会把同一条消息推给
 * 所有连接，导致同一条 QQ 消息被重复投递给模型。这里做跨进程互斥，保证
 * 同一时间只有一个实例消费消息流。
 *
 * 锁基于文件系统，Windows、macOS、Linux 行为一致。正常退出会立刻释放；
 * 持锁进程被杀掉时，下一次加锁会按归属文件里的 PID 立刻接管，不用等
 * `STALE_MS` 过期。
 *
 * @param options 可选参数，`onCompromised` 用于感知心跳失效。
 * @returns 取得锁时返回释放句柄，已被占用时返回 undefined。
 */
export async function acquireBotLock(options: BotLockOptions = {}): Promise<BotLock | undefined> {
  return acquire(options, true)
}

async function acquire(options: BotLockOptions, retryDead: boolean): Promise<BotLock | undefined> {
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
    await writeOwner(lockPath)
    return {
      release: async () => {
        await clearOwner(lockPath)
        try {
          await release()
        } catch (error) {
          // 锁已经失效时释放会报 ERELEASED，锁目录由接管方清理。
          if ((error as NodeJS.ErrnoException).code !== "ERELEASED") throw error
        }
      },
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      // 持锁进程已经死了就立刻清掉，只重试一次，避免和并发接管来回抢。
      if (retryDead && (await reclaimDeadLock(lockPath))) return acquire(options, false)
      return undefined
    }
    // 其它错误交给调用方处理。
    throw error
  }
}
