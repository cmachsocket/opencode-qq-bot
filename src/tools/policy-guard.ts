import type { Plugin } from "@opencode/plugin"
import { targetKey, targetLabel } from "../chat"
import type { Logger } from "../logger"
import type { SessionManager } from "../session/manager"
import type { ToolPolicy } from "./policy"

/** 会开启独立会话的工具名；不同版本分别叫 subagent 与 task。 */
const SUBAGENT_TOOLS = new Set(["subagent", "task"])

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
    // 子代理会开一个不受 QQ 聊天约束的新会话，哪怕配置档放行也一律拒绝。
    if (SUBAGENT_TOOLS.has(event.tool)) {
      logger.warn(`${targetLabel(active.target)} 会话里拒绝创建子代理 ${event.tool}`)
      throw new Error("QQ 聊天会话里不能创建子代理：子会话不会继承按聊天的工具限制。")
    }
    const allowed = await policy.allow(active.role, targetKey(active.target), [event.tool])
    logger.debug(`${targetLabel(active.target)} 工具策略检查`, {
      role: active.role,
      profile: await policy.profileOf(active.role, targetKey(active.target)),
      tool: event.tool,
      allowed: allowed.size > 0,
    })
    if (allowed.size > 0) return
    logger.warn(
      `${targetLabel(active.target)} 会话里 ${active.role} 尝试调用工具 ${event.tool}，已被工具配置拒绝`,
    )
    throw new Error(
      `当前用户不能使用工具 ${event.tool}：工具权限由 tool-profiles.json 按聊天分配。`,
    )
  })
}
