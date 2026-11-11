import { type ChatTarget, targetKey, targetLabel } from "../chat"
import type { CommandDefinition } from "../commands"
import type { QQBotConfig } from "../config"
import type { Logger } from "../logger"
import type { OutboundMedia } from "../media-path"
import type { QQClient } from "../naplink/client"
import type { SendRateLimiter } from "../rate-limit"
import type { SensitiveChecker } from "../sensitive"
import { createPlainSender, sendFileMessage } from "../tools/qq"
import type { DiaryCollector } from "./collector"
import { dateKey, isDateKey } from "./format"
import { diaryScopeChat, isDiaryScopeChat } from "./scope"
import { readDiaryHead, type DiaryStore } from "./store"
import type { DiarySummarizer } from "./summary"

/** 命令名。TUI 侧注册为 `qq-diary`，QQ 私聊里用 `/diary`。 */
export const DIARY_COMMAND = "diary"

/** `/diary` 支持的动作。 */
export type DiaryAction = "write" | "list" | "show" | "auto" | "usage"

/** 解析出来的命令参数。 */
export interface DiaryCommandArgs {
  action: DiaryAction
  /** 日期键，形如 `2026-11-10`。 */
  date?: string
  /** 手写日记的正文。 */
  content?: string
  /** 列出最近几篇。 */
  days?: number
}

/** 列出日记时默认看几篇。 */
export const DIARY_LIST_DAYS = 7

/** 命令用法说明。 */
export const DIARY_USAGE = [
  "用法：/diary <write|list|show|auto>",
  "write [日期] <内容>  写一篇日记（默认今天）",
  "list [天数]        列出最近几篇日记（默认 7 篇）",
  "show <日期>        看某天的日记，日期用 YYYY-MM-DD",
  "auto [日期]        立刻生成或重生成某天的自动总结",
].join("\n")

/**
 * 解析命令参数。
 *
 * 兼容 `/diary write ...`、`/qq-diary write ...` 与 `diary write ...` 三种写法。
 */
export function parseDiaryArgs(text: string): DiaryCommandArgs {
  const raw = text.trim()
  const withoutName = raw.replace(/^\/?(?:qq-)?diary\b[:：]?/i, "").trim()
  if (!withoutName) return { action: "usage" }
  const parts = withoutName.split(/\s+/)
  const action = (parts[0] ?? "").toLowerCase()
  const tail = parts.slice(1).join(" ").trim()

  if (action === "write") {
    // 正文前面可以带一个日期：`write 2026-11-10 今天聊了…`。
    const match = /^(\d{4}-\d{2}-\d{2})\s+([\s\S]*)$/.exec(tail)
    const date = match?.[1]
    if (date && isDateKey(date)) {
      return { action: "write", date, content: (match?.[2] ?? "").trim() }
    }
    return { action: "write", content: tail }
  }
  if (action === "list") {
    const days = Number(tail)
    return { action: "list", days: Number.isInteger(days) && days > 0 ? days : DIARY_LIST_DAYS }
  }
  if (action === "show") {
    const date = (parts[1] ?? "").trim()
    return date ? { action: "show", date } : { action: "show" }
  }
  if (action === "auto") {
    const date = (parts[1] ?? "").trim()
    return date ? { action: "auto", date } : { action: "auto" }
  }
  return { action: "usage" }
}

/** 日记命令的执行依赖。 */
export interface DiaryRunnerDeps {
  config: QQBotConfig
  logger: Logger
  client: QQClient
  limiter: SendRateLimiter
  /** 出站媒体的路径把关，发送日记文件时用。 */
  outbound: OutboundMedia
  /** 出站敏感信息检查。 */
  sensitive: SensitiveChecker
  /** 日记读写。 */
  store: DiaryStore
  /** 素材读取。 */
  collector: DiaryCollector
  /** 自动总结。 */
  summarizer: DiarySummarizer
}

/** 日记命令的执行器：TUI 命令与 QQ 私聊共用。 */
export interface DiaryCommandRunner {
  /** 在指定聊天里执行命令文本。 */
  run(target: ChatTarget, text: string): Promise<void>
}

/** 列出日记的文本。 */
export function formatDiaryList(
  chat: string,
  days: number,
  entries: readonly { date: string; title: string }[],
): string {
  const head = `日记（${chat}，最近 ${days} 篇）`
  if (entries.length === 0) return `${head}\n还没有日记。`
  return [head, ...entries.map((entry) => `${entry.date} ${entry.title}`)].join("\n")
}

/** 创建日记命令执行器；同一时间只跑一个自动总结任务。 */
export function createDiaryRunner(deps: DiaryRunnerDeps): DiaryCommandRunner {
  const { config, logger, client, limiter, outbound, sensitive, store, collector, summarizer } =
    deps
  let running = false

  const report = createPlainSender(client, {
    delayMs: config.sendDelayMs,
    limiter,
    logger,
    failure: (target) => `${targetLabel(target)} 发送日记结果失败`,
  })

  /** 发一篇日记：一行说明加文件本身。 */
  const sendDiaryFile = async (target: ChatTarget, date: string): Promise<void> => {
    const file = store.filePath(targetKey(target), date)
    // `sendFileMessage` 只查文件名和路径，日记正文得自己过一遍出站检查。
    let body: string
    try {
      body = await readDiaryHead(file)
    } catch (error) {
      logger.error(`${targetLabel(target)} 的日记文件读取失败，放弃发送`, error)
      await report(target, "日记文件读取失败，没有发送。")
      return
    }
    if (!sensitive.check(body).allowed) {
      logger.warn(`${targetLabel(target)} 的日记正文包含敏感信息，已拦截`)
      await report(target, "日记正文包含敏感信息，已拦截。")
      return
    }
    await sendFileMessage(client, target, file, {
      name: `日记-${date}.md`,
      limiter,
      outbound,
      sensitive,
    })
  }

  const runWrite = async (target: ChatTarget, args: DiaryCommandArgs): Promise<void> => {
    const content = (args.content ?? "").trim()
    if (!content) {
      await report(target, "要写什么？用法：/diary write [日期] <内容>")
      return
    }
    const date = args.date ?? dateKey()
    const entry = await store.write(targetKey(target), date, {
      title: firstLine(content),
      body: content,
      source: "manual",
    })
    await report(target, `已写入 ${date} 的日记：${entry.title}`)
  }

  const runList = async (target: ChatTarget, args: DiaryCommandArgs): Promise<void> => {
    const days = args.days ?? DIARY_LIST_DAYS
    const entries = await store.list(targetKey(target), days)
    await report(target, formatDiaryList(targetKey(target), days, entries))
  }

  const runShow = async (target: ChatTarget, args: DiaryCommandArgs): Promise<void> => {
    const date = args.date ?? ""
    if (!date || !isDateKey(date)) {
      await report(target, "要看哪天的日记？用法：/diary show <日期>，日期用 YYYY-MM-DD")
      return
    }
    const entry = await store.read(targetKey(target), date)
    if (!entry) {
      await report(target, `没有找到 ${date} 的日记。`)
      return
    }
    await report(target, `${date} 的日记`)
    await sendDiaryFile(target, date).catch((error: unknown) => {
      logger.error(`${targetLabel(target)} 发送日记文件失败`, error)
      return report(
        target,
        `日记文件发送失败：${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  const runAuto = async (target: ChatTarget, args: DiaryCommandArgs): Promise<void> => {
    const date = args.date ?? dateKey()
    if (!isDateKey(date)) {
      await report(target, "要生成哪天的日记？用法：/diary auto [日期]，日期用 YYYY-MM-DD")
      return
    }
    if (!(await collector.has(targetKey(target), date))) {
      await report(target, `${date} 没有聊天素材，跳过总结。`)
      return
    }
    if (running) {
      await report(target, "已经有日记总结任务在跑了，请等它结束。")
      return
    }
    running = true
    // 总结可能要跑很久，放到后台执行，结果用 QQ 消息回。
    void (async () => {
      await report(target, `开始生成 ${date} 的日记…`)
      const title = await summarizer.summarize(targetKey(target), date)
      if (!title) {
        await report(target, `${date} 的日记总结失败，素材保留待下次重试。`)
        return
      }
      await report(target, `${date} 的日记已生成：${title}`)
      await sendDiaryFile(target, date).catch((error: unknown) => {
        logger.error(`${targetLabel(target)} 发送日记文件失败`, error)
      })
    })()
      .catch((error: unknown) => {
        logger.error("日记总结任务失败", error)
        return report(
          target,
          `日记总结失败：${error instanceof Error ? error.message : String(error)}`,
        )
      })
      .finally(() => {
        running = false
      })
  }

  const run = async (target: ChatTarget, text: string): Promise<void> => {
    const args = parseDiaryArgs(text)
    switch (args.action) {
      case "write":
        await runWrite(target, args)
        return
      case "list":
        await runList(target, args)
        return
      case "show":
        await runShow(target, args)
        return
      case "auto":
        await runAuto(target, args)
        return
      default:
        await report(target, DIARY_USAGE)
    }
  }

  return { run }
}

/** 取正文的第一行做标题。 */
function firstLine(content: string): string {
  const line = content
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  return line ?? ""
}

/** 日记命令的用法行，`/help` 直接复用。 */
const DIARY_USAGE_LINES = [
  "/diary write [日期] <内容> — 写一篇日记（默认今天）",
  "/diary list [天数] — 列出最近几篇日记（默认 7 篇）",
  "/diary show <日期> — 看某天的日记，日期用 YYYY-MM-DD",
  "/diary auto [日期] — 立刻生成或重生成某天的自动总结",
]

/**
 * 把日记命令接进共享命令表。
 *
 * TUI 侧注册成 `/qq-diary`，QQ 私聊里是 `/diary`；
 * 命令自己负责发消息，所以 `run` 不返回文本。
 */
export function diaryCommand(runner: DiaryCommandRunner): CommandDefinition {
  return {
    name: DIARY_COMMAND,
    description: "写、看、列出聊天日记：write 手写，show 看某天，list 列最近几篇，auto 自动总结。",
    usage: DIARY_USAGE_LINES,
    run: async (context, args) => {
      // 日记只属于 owner：QQ 侧只认 owner 自己的私聊。
      const scope = diaryScopeChat(context.config)
      if (!scope) return "没有配置 ownerQQ，无法使用日记。"
      if (context.source !== "tui" && !isDiaryScopeChat(context.config, context.target)) {
        return "日记只在 owner 自己的私聊里可用。"
      }
      // TUI 侧同样按 owner 私聊操作：不能在绑到群聊的会话里把日记发进群里。
      await runner.run(scope, args.join(" "))
    },
  }
}
