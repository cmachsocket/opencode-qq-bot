import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** 群里发消息用的工具名（命名空间 qq 下的 send_message）。 */
export const SEND_MESSAGE_TOOL = "qq_send_message"

const GUIDELINES = `
GUIDELINES:
你在一个群聊里面，你收到的消息不一定是发给你的，你需要根据上下文和语境来判断是否回复。
对于一条消息，<quote>...</quote> 里面的内容是引用的消息，通常是你之前发过的消息或者其他人的消息，你需要根据这些引用来判断当前消息的语境。<forward>...</forward> 里面是合并转发消息的内容，每条前面的名字是转发节点的发送者。user_name : message 是用户发给你的消息, 不同的user_name代表不同的用户,你需要根据这些消息来判断每个用户的意图和情感。
重要！！！发送消息时，**必须**调用 ${SEND_MESSAGE_TOOL} 工具；任何直接输出的文字都会被**完全丢弃**，不会作为消息内容发送!!!
${SEND_MESSAGE_TOOL} 工具是强制调用的，每轮都必须调用一次；不想回复时把参数 reply 设成 false（content 留空），相当于已读不回。不需要每一条都回复，像人一样选择性回复就行。
不要输出markdown、代码块、表格、列表等格式化内容，直接输出纯文本即可。
`

/** 主动发起话题时追加的模式说明。 */
export const PROACTIVE_HINT = `
[模式] 主动发起话题。不一定与记忆相关，也不一定与当前群聊的最新消息相关。
可以是一个问题、一个建议、一个有趣的想法、一个冷知识、一个笑话等。
注意，不要再重复之前的话题，也不要重复之前的消息内容。
你需要调用 ${SEND_MESSAGE_TOOL} 工具把话题发到群里。
`

/** 从模块所在目录向上查找 SOUL.txt，兼容 src/ 与 dist/ 两种布局。 */
export function findSoulFile(startDir: string, maxDepth = 5): string | undefined {
  let current = resolve(startDir)
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = join(current, "SOUL.txt")
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/** 定位角色设定文件：显式路径优先，否则用包内默认。 */
export function resolveSoulPath(
  explicitPath: string | undefined,
  moduleDir: string,
  cwd: string,
): string | undefined {
  if (explicitPath) {
    return isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath)
  }
  return findSoulFile(moduleDir)
}

/** 读取角色设定，失败时返回空字符串。 */
export async function loadSoul(path: string | undefined): Promise<string> {
  if (!path) return ""
  try {
    return await readFile(path, "utf-8")
  } catch {
    return ""
  }
}

/** 组装完整的系统提示词。 */
export function buildSystemPrompt(soul: string): string {
  const base = soul.trim()
  return base ? `${base}\n${GUIDELINES}` : GUIDELINES.trim()
}

/** 当前时间文本，注入到系统提示里让模型知道现在几点。 */
export function currentTimeText(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

/** 供测试与其它模块定位包内 SOUL.txt。 */
export function packageDirectory(): string {
  return dirname(fileURLToPath(import.meta.url))
}
