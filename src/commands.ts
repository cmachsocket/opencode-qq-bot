import {
  type ChatTarget,
  commandTarget,
  configuredTargets,
  parseTargetKey,
  targetLabel,
} from "./chat"
import type { QQBotConfig } from "./config"
import type { SessionManager } from "./session/manager"
import { roleOf, type Role, type ToolPolicy } from "./tools/policy"

/**
 * 管理命令只在 owner 与管理员自己的私聊里生效。
 *
 * 群聊、普通成员的私聊一律照常交给模型；要求发送者就是该私聊的主人，
 * 避免别人冒用管理员会话。
 */
export function isCommandChat(config: QQBotConfig, target: ChatTarget, senderQQ: string): boolean {
  if (target.kind !== "private") return false
  if (Number(senderQQ) !== target.id) return false
  return target.id === config.ownerQQ || config.admins.includes(target.id)
}

/** TUI 命令名的前缀：避免与 OpenCode 内置命令（/help、/status 等）冲突。 */
export const TUI_COMMAND_PREFIX = "qq-"

/** TUI 里注册的命令名，例如 `qq-reset`。 */
export function tuiCommandName(name: string): string {
  return `${TUI_COMMAND_PREFIX}${name}`
}

/** QQ 侧同时接受带前缀的写法（/qq-reset），这里把前缀脱掉。 */
export function stripCommandPrefix(name: string): string {
  return name.startsWith(TUI_COMMAND_PREFIX) ? name.slice(TUI_COMMAND_PREFIX.length) : name
}

/** 解析 `/name arg1 arg2`；不是命令时返回 undefined。名字不带斜杠。 */
export function parseCommand(text: string): { name: string; args: string[] } | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return undefined
  const [head, ...args] = trimmed.split(/\s+/)
  if (!head || head.length < 2) return undefined
  return { name: head.slice(1).toLowerCase(), args }
}

/**
 * 从 TUI 命令输入里取出参数。
 *
 * 兼容 `/reset group:1`、`reset group:1` 与只写 `group:1` 三种形式。
 */
export function splitArgs(text: string, name: string): string[] {
  const raw = text.trim()
  const withoutName = raw.replace(new RegExp(`^/?${name}\\b[:：]?`, "i"), "").trim()
  return withoutName ? withoutName.split(/\s+/) : []
}

/** 解析聊天参数：`group:123`、`private:123`，也接受纯数字当群号。 */
export function parseChatArg(value: string): ChatTarget | undefined {
  const key = parseTargetKey(value)
  if (key) return key
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) return undefined
  return { kind: "group", id }
}

/** 命令执行所需的依赖；QQ 命令把 target 设为发送者私聊。 */
export interface CommandContext {
  config: QQBotConfig
  manager: SessionManager
  policy: ToolPolicy
  /** 命令所属的聊天：QQ 命令是发送者私聊，TUI 命令是会话绑定的聊天。 */
  target: ChatTarget
  /** 当前注册的全部工具名。 */
  toolNames: () => Promise<string[]>
}

/** 执行一条命令时额外带上整张命令表，`/help` 才能列出全部命令。 */
export interface CommandRunContext extends CommandContext {
  commands: readonly CommandDefinition[]
}

/** 一条管理命令：QQ 与 TUI 共用同一份实现。 */
export interface CommandDefinition {
  /** 命令名，不带斜杠。 */
  name: string
  /** 一句话说明，同时用作 TUI 命令的描述。 */
  description: string
  /** `/help` 里列出的用法行。 */
  usage: string[]
  /**
   * 执行命令。
   *
   * 返回文本表示由调用方发回聊天；返回 `undefined` 表示命令自己负责发送
   * （例如需要边跑边发进度的表情标注）。
   */
  run: (context: CommandRunContext, args: string[]) => Promise<string | void>
}

function sessionLine(manager: SessionManager, target: ChatTarget): string {
  const entry = manager
    .snapshot()
    .find((item) => item.target.kind === target.kind && item.target.id === target.id)
  if (!entry) return `${targetLabel(target)}：未开始`
  const parts = [entry.sessionID ? `会话 ${entry.sessionID}` : "未绑定会话"]
  parts.push(entry.busy ? "执行中" : "空闲")
  if (entry.buffered > 0) parts.push(`缓存 ${entry.buffered} 条`)
  if (entry.pending) parts.push("有待重试批次")
  return `${targetLabel(target)}：${parts.join("，")}`
}

/** 私聊按主人身份取角色，群聊统一按普通成员。 */
function roleForChat(config: QQBotConfig, target: ChatTarget): Role {
  return target.kind === "private" ? roleOf(config, String(target.id)) : "member"
}

/** 列出配置里的目标与已建状态的聊天，去重后按 `kind:id` 排序。 */
function allTargets(config: QQBotConfig, manager: SessionManager): ChatTarget[] {
  const seen = new Set<string>()
  return [...configuredTargets(config), ...manager.snapshot().map((item) => item.target)]
    .filter((target) => {
      const key = `${target.kind}:${target.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
}

/** `/help` 的内容直接从命令表生成，两边不会各写一份。 */
function helpText(commands: readonly CommandDefinition[]): string {
  return ["可用命令：", ...commands.flatMap((command) => command.usage)].join("\n")
}

async function runStatus(context: CommandContext): Promise<string> {
  const { config, manager } = context
  const targets = configuredTargets(config)
  const lines =
    targets.length > 0
      ? targets.map((target) => sessionLine(manager, target))
      : ["没有配置任何群聊或私聊"]
  return ["QQ 机器人状态", ...lines].join("\n")
}

async function runReset(context: CommandContext, args: string[]): Promise<string> {
  const { config, manager } = context
  const requested = args[0]
  if (!requested) {
    // 不带参数时只列清单，不猜要重置哪个：重置是不可撤销的。
    const targets = allTargets(config, manager)
    return targets.length > 0
      ? [
          "要重置哪个聊天？把目标加在命令后面：",
          ...targets.map(
            (target) => `/reset ${target.kind}:${target.id} — ${sessionLine(manager, target)}`,
          ),
        ].join("\n")
      : "没有配置任何群聊或私聊"
  }
  const target = parseChatArg(requested)
  if (!target) return `无法识别聊天：${requested}（示例：/reset group:123）`
  const result = await manager.resetTarget(target)
  const lines = [
    `${targetLabel(target)} 已重置`,
    result.interrupted ? "原回合已打断" : "原回合没有在执行",
  ]
  if (result.sessionID) lines.push(`已删除会话 ${result.sessionID}`)
  lines.push("下一条消息会新建会话")
  return lines.join("\n")
}

async function runTools(context: CommandContext, args: string[]): Promise<string> {
  const { config, policy, toolNames } = context
  const requested = args[0]
  if (requested) {
    const target = parseChatArg(requested)
    if (!target) return `无法识别聊天：${requested}（示例：/tools group:123）`
    const key = `${target.kind}:${target.id}`
    const role = roleForChat(config, target)
    const names = await toolNames()
    const allowed = [...(await policy.allow(role, key, names))].sort()
    const profile = await policy.profileOf(role, key)
    return [
      `${targetLabel(target)} 使用配置档 ${profile}`,
      allowed.length > 0 ? allowed.join("、") : "没有可用工具",
    ].join("\n")
  }
  const names = await toolNames()
  const lines = [`默认配置档：${(await policy.current()).defaultProfile}`]
  for (const target of configuredTargets(config)) {
    const role = roleForChat(config, target)
    const key = `${target.kind}:${target.id}`
    const profile = await policy.profileOf(role, key)
    const count = (await policy.allow(role, key, names)).size
    lines.push(`${targetLabel(target)}：${profile}（${count} 个工具）`)
  }
  return lines.join("\n")
}

/** 管理命令表：QQ 侧按文本匹配，TUI 侧注册成同名命令。 */
export const COMMANDS: readonly CommandDefinition[] = [
  {
    name: "help",
    description: "显示管理命令说明",
    usage: ["/help — 显示这条说明"],
    run: async (context) => helpText(context.commands),
  },
  {
    name: "status",
    description: "查看各聊天的会话与队列状态",
    usage: ["/status — 各聊天的会话与队列状态"],
    run: runStatus,
  },
  {
    name: "reset",
    description: "重置聊天会话；不带参数时列出所有聊天",
    usage: ["/reset — 列出所有聊天", "/reset group:123 — 重置指定聊天（也支持 private:123）"],
    run: runReset,
  },
  {
    name: "tools",
    description: "查看聊天使用的工具配置档",
    usage: ["/tools — 各聊天使用的工具配置档", "/tools group:123 — 列出该聊天可用的工具"],
    run: runTools,
  },
]

/** QQ 命令的依赖：在共享上下文上补一个回发通道。 */
export interface CommandDeps extends CommandContext {
  /** 把纯文本发回聊天（带限流）。 */
  send: (target: ChatTarget, text: string) => Promise<void>
}

/**
 * 处理 QQ 侧的管理命令。
 *
 * 返回 true 表示已应答，调用方不要再交给模型；返回 false 表示不是已知命令。
 */
export async function handleCommand(
  text: string,
  deps: CommandDeps,
  commands: readonly CommandDefinition[] = COMMANDS,
): Promise<boolean> {
  const parsed = parseCommand(text)
  if (!parsed) return false
  const name = stripCommandPrefix(parsed.name)
  const command = commands.find((item) => item.name === name)
  if (!command) return false
  const body = await command.run({ ...deps, commands }, parsed.args)
  if (body !== undefined) await deps.send(deps.target, body)
  return true
}

/** 命令结果的投递目标：优先会话绑定的聊天，没有就用第一个配置目标。 */
export function commandTargetFor(
  config: QQBotConfig,
  manager: SessionManager,
  sessionID: string,
): ChatTarget | undefined {
  return commandTarget(config, manager.targetForSession(sessionID))
}
