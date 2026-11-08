import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../logger"
import type { SessionManager, Turn } from "../session/manager"

/** 连续调用发送工具时回给模型的说明。 */
export const DUPLICATE_SEND_REFUSAL =
  "禁止连续调用发送工具：上一步已经发送过消息，再发可能重复。请先调用其它工具（例如查看消息或整理内容），或直接结束本轮。"

/** 匹配 qq_send_message 等发送工具；钩子里可能带或不带命名空间。 */
const SEND_TOOL = /^(?:qq_)?send[_-]/

interface LastCall {
  /** 所属轮次；轮次变化时重新计数，避免上一轮的最后一次发送影响下一轮。 */
  turn: Turn | undefined
  send: boolean
  /** 被放行的发送调用 id，用于在发送失败时撤销标记。 */
  callID?: string
}

export interface SendGuardDeps {
  ctx: Plugin.Context
  logger: Logger
  manager: SessionManager
}

/**
 * 禁止模型连续调用发送工具，避免同一条消息被重复发送。
 * 只约束 QQ 轮次，人工在 TUI 里驱动时不受影响。
 */
export async function registerSendGuard(
  deps: SendGuardDeps,
): Promise<{ dispose(): Promise<void> }> {
  const { ctx, logger, manager } = deps
  const last = new Map<string, LastCall>()

  const before = await ctx.tool.hook("execute.before", async (event) => {
    const active = manager.activeTurn(event.sessionID)
    if (!active) return
    const turn = active.turn
    const previous = last.get(event.sessionID)
    const send = SEND_TOOL.test(event.tool)
    if (previous !== undefined && previous.turn === turn && previous.send && send) {
      // 保持上一条已放行调用的记录：被拒绝的调用不改变状态，连续重试会一直被拒绝。
      logger.warn(`模型连续调用 ${event.tool}，已拒绝`)
      throw new Error(DUPLICATE_SEND_REFUSAL)
    }
    last.set(event.sessionID, { turn, send, ...(send ? { callID: event.id } : {}) })
  })

  const after = await ctx.tool.hook("execute.after", async (event) => {
    // 发送失败不算“已经发过”，允许立刻重试；被拒绝的调用不会走到这里。
    // 工具返回 error 文本时状态仍是 completed，需要看结果里的 failed 标记；
    // 限流拒绝会带 retryable: false，保持“已发送”状态，避免模型反复重试。
    const metadata =
      event.status === "completed"
        ? (event.result.metadata as { failed?: boolean; retryable?: boolean } | undefined)
        : undefined
    if (event.status !== "error" && !(metadata?.failed === true && metadata.retryable !== false)) {
      return
    }
    const entry = last.get(event.sessionID)
    if (entry?.callID !== event.id) return
    entry.send = false
    delete entry.callID
  })

  return {
    async dispose() {
      await before.dispose()
      await after.dispose()
    },
  }
}
