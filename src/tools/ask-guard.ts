import type { Plugin } from "@opencode/plugin"
import { targetLabel } from "../chat"
import type { Logger } from "../logger"
import type { SessionManager } from "../session/manager"

/** OpenCode 内置的“向用户提问”工具 id。 */
export const QUESTION_TOOL = "question"

/** 拒绝提问工具时回给模型的说明。 */
export const ASK_REFUSAL =
  "不允许调用 question 工具：QQ 会话里请直接用 qq_send_message 询问用户（Code Mode 下调用方式为 tools.qq.send_message）。"

export interface AskGuardDeps {
  ctx: Plugin.Context
  logger: Logger
  manager: SessionManager
}

/**
 * 在 QQ 会话里拦截内置 question 工具，要求模型改用 qq_send_message 询问用户。
 * 非 QQ 会话不受影响。
 */
export async function registerAskGuard(deps: AskGuardDeps): Promise<{ dispose(): Promise<void> }> {
  const { ctx, logger, manager } = deps
  return await ctx.tool.hook("execute.before", async (event) => {
    if (event.tool !== QUESTION_TOOL) return
    const target = manager.targetForSession(event.sessionID)
    if (!target) return
    logger.warn(`${targetLabel(target)} 会话里模型尝试调用 ${QUESTION_TOOL} 工具，已拒绝`)
    throw new Error(ASK_REFUSAL)
  })
}
