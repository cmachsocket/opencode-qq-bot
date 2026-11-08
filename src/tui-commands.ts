import type { Plugin } from "@opencode/plugin"
import { type CommandDefinition, commandTargetFor, splitArgs, tuiCommandName } from "./commands"
import type { QQBotConfig } from "./config"
import type { Logger } from "./logger"
import type { ChatOverrides } from "./overrides"
import type { QQClient } from "./naplink/client"
import type { SendRateLimiter } from "./rate-limit"
import type { SessionManager } from "./session/manager"
import type { ToolPolicy } from "./tools/policy"
import { createPlainSender } from "./tools/qq"

export { TUI_COMMAND_PREFIX, tuiCommandName } from "./commands"

export interface TuiCommandDeps {
  ctx: Plugin.Context
  config: QQBotConfig
  logger: Logger
  manager: SessionManager
  policy: ToolPolicy
  /** 会话行为覆盖，命令要展示各聊天的唤醒方式。 */
  overrides: ChatOverrides
  client: QQClient
  /** 命令结果同样走限流。 */
  limiter: SendRateLimiter
  /** QQ 与 TUI 共用的命令表。 */
  commands: readonly CommandDefinition[]
}

/**
 * 把命令表以 `qq-` 前缀注册成 TUI 命令，与 QQ 侧共用同一份实现。
 *
 * 结果发到会话绑定的 QQ 聊天；没有绑定就发第一个配置目标。
 */
export async function registerTuiCommands(
  deps: TuiCommandDeps,
): Promise<{ dispose(): Promise<void> }> {
  const { ctx, config, logger, manager, policy, overrides, client, limiter, commands } = deps

  const toolNames = async () => (await ctx.tool.list()).map((tool) => tool.id)

  const send = createPlainSender(client, {
    delayMs: config.sendDelayMs,
    limiter,
    logger,
    failure: () => "发送 TUI 命令结果失败",
  })

  return await ctx.command.transform((editor) => {
    for (const command of commands) {
      const name = tuiCommandName(command.name)
      editor.add({
        name,
        description: command.description,
        execute: async (input) => {
          const target = commandTargetFor(config, manager, input.sessionID)
          if (!target) {
            logger.warn(`没有可用的 QQ 目标，无法执行 /${name}`)
            return
          }
          const args = splitArgs(input.prompt.text ?? "", name)
          const body = await command.run(
            { config, manager, policy, overrides, target, toolNames, commands },
            args,
          )
          if (body !== undefined) await send(target, body)
        },
      })
    }
  })
}
