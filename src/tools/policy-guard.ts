import type { Plugin } from "@opencode/plugin"
import { targetKey, targetLabel } from "../chat"
import type { Logger } from "../logger"
import type { SessionManager } from "../session/manager"
import type { ToolPolicy } from "./policy"

export interface ToolPolicyGuardDeps {
  ctx: Plugin.Context
  logger: Logger
  manager: SessionManager
  policy: ToolPolicy
}

/**
 * 按聊天与角色拦截工具调用。
 *
 * 上下文钩子会把不允许的工具从列表里删掉，这里是第二道闸：
 * Code Mode、并发调用或子代理绕过列表时仍然执行不了。
 * 只对正在执行 QQ 轮次的会话生效，人工在 TUI 里驱动的会话不受影响。
 */
export async function registerToolPolicy(
  deps: ToolPolicyGuardDeps,
): Promise<{ dispose(): Promise<void> }> {
  const { ctx, logger, manager, policy } = deps
  return await ctx.tool.hook("execute.before", async (event) => {
    const active = manager.activeTurn(event.sessionID)
    if (!active) return
    const allowed = await policy.allow(active.role, targetKey(active.target), [event.tool])
    if (allowed.size > 0) return
    logger.warn(
      `${targetLabel(active.target)} 会话里 ${active.role} 尝试调用工具 ${event.tool}，已被工具配置拒绝`,
    )
    throw new Error(
      `当前用户不能使用工具 ${event.tool}：工具权限由 tool-profiles.json 按聊天分配。`,
    )
  })
}
