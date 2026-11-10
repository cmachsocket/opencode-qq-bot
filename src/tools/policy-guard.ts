import type { Plugin } from "@opencode/plugin"
import { targetKey, targetLabel } from "../chat"
import type { Logger } from "../logger"
import type { SessionManager } from "../session/manager"
import type { ToolPolicy } from "./policy"
import { QQ_REQUEST_REPLY_TOOL } from "./qq"

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
 * 只看会话绑定的聊天，不看进程内是否还有轮次状态：插件重启后
 * 上游可能还在跑，此时 `current` 为空但权限仍要按最近一轮的角色收窄。
 */
export async function registerToolPolicy(
  deps: ToolPolicyGuardDeps,
): Promise<{ dispose(): Promise<void> }> {
  const { ctx, logger, manager, policy } = deps
  return await ctx.tool.hook("execute.before", async (event) => {
    const target = manager.targetForSession(event.sessionID)
    if (!target) return
    const role = manager.currentRole(event.sessionID)
    // 子代理会开一个不受 QQ 聊天约束的新会话，哪怕配置档放行也一律拒绝。
    if (SUBAGENT_TOOLS.has(event.tool)) {
      logger.warn(`${targetLabel(target)} 会话里拒绝创建子代理 ${event.tool}`)
      throw new Error("QQ 聊天会话里不能创建子代理：子会话不会继承按聊天的工具限制。")
    }
    // 申请回复权限的工具必须一直放行：不然模型永远拿不到发送权限。
    if (event.tool === QQ_REQUEST_REPLY_TOOL) return
    const allowed = await policy.allow(role, targetKey(target), [event.tool])
    logger.debug(`${targetLabel(target)} 工具策略检查`, {
      role,
      profile: await policy.profileOf(role, targetKey(target)),
      tool: event.tool,
      allowed: allowed.size > 0,
    })
    if (allowed.size > 0) return
    logger.warn(
      `${targetLabel(target)} 会话里 ${role} 尝试调用工具 ${event.tool}，已被工具配置拒绝`,
    )
    throw new Error(
      `当前用户不能使用工具 ${event.tool}：工具权限由 tool-profiles.json 按聊天分配。`,
    )
  })
}
