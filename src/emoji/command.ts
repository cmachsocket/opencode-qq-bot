import { type ChatTarget, targetLabel } from "../chat"
import type { CommandDefinition } from "../commands"
import type { QQBotConfig } from "../config"
import type { Logger } from "../logger"
import type { QQClient } from "../naplink/client"
import type { SendRateLimiter } from "../rate-limit"
import { createPlainSender } from "../tools/qq"
import { type CustomFace, faceTag, type FavoriteStore, formatFavoriteList } from "./favorites"
import { type FavoriteIndex, favoriteKey } from "./favorite-index"
import type { EmojiLabeler } from "./label"

/** `/emoji-label` 支持的动作。 */
export type EmojiLabelAction = "all" | "inc" | "list" | "usage"

/** 命令名。TUI 侧注册为 `qq-emoji-label`，QQ 私聊里用 `/emoji-label`。 */
export const EMOJI_LABEL_COMMAND = "emoji-label"

/** 命令用法说明。 */
export const EMOJI_LABEL_USAGE = [
  "用法：/emoji-label <all|inc|list>",
  "all   重新标注全部收藏表情",
  "inc   只标注还没有标签的收藏表情",
  "list  列出收藏表情的编号与标签",
].join("\n")

/**
 * 解析命令参数。
 *
 * 兼容 `/emoji-label all`、`/qq-emoji-label all`、`emoji-label all` 和只传 `all` 四种写法。
 */
export function parseEmojiLabelArgs(text: string): EmojiLabelAction {
  const raw = text.trim()
  const withoutName = raw.replace(/^\/?(?:qq-)?emoji-label\b[:：]?/i, "").trim()
  const arg = (withoutName.split(/\s+/)[0] ?? "").toLowerCase()
  if (arg === "all") return "all"
  if (arg === "inc" || arg === "incremental") return "inc"
  if (arg === "list") return "list"
  return "usage"
}

/** 标注模式：全部重标，或只补没有标签的。 */
export type EmojiLabelMode = "all" | "inc"

/**
 * 按模式挑出需要标注的表情。
 *
 * `inc` 只处理没有标签的，`all` 处理全部。
 */
export function selectFacesToLabel(
  faces: readonly CustomFace[],
  mode: EmojiLabelMode,
): CustomFace[] {
  return mode === "inc" ? faces.filter((face) => !faceTag(face)) : [...faces]
}

/** 表情命令的执行依赖，不区分 TUI 还是 QQ。 */
export interface EmojiRunnerDeps {
  config: QQBotConfig
  logger: Logger
  client: QQClient
  favorites: FavoriteStore
  favoriteIndex: FavoriteIndex
  labeler: EmojiLabeler
  limiter: SendRateLimiter
}

/** 表情命令的执行器：TUI 命令与 QQ 私聊共用。 */
export interface EmojiCommandRunner {
  /** 在指定聊天里执行命令文本。 */
  run(target: ChatTarget, text: string): Promise<void>
}

/** 创建表情命令执行器；同一个实例保证标注任务排队。 */
export function createEmojiRunner(deps: EmojiRunnerDeps): EmojiCommandRunner {
  const { config, logger, client, favorites, favoriteIndex, labeler, limiter } = deps
  let running = false

  const report = createPlainSender(client, {
    delayMs: config.sendDelayMs,
    limiter,
    logger,
    failure: (target) => `${targetLabel(target)} 发送表情标签结果失败`,
  })

  const runLabeling = async (target: ChatTarget, mode: EmojiLabelMode): Promise<void> => {
    const faces = await favorites.list({ refresh: true })
    // 先把编号分配好，标注结果里的编号才对得上。
    const rows = await favoriteIndex.sync(faces)
    const idByKey = new Map<string, number>()
    for (const row of rows) {
      const key = favoriteKey(row.face)
      if (key) idByKey.set(key, row.id)
    }
    const pending = selectFacesToLabel(faces, mode)
    if (pending.length === 0) {
      await report(target, mode === "inc" ? "所有收藏表情都已经有标签了。" : "没有读取到收藏表情。")
      return
    }
    await report(target, `开始为 ${pending.length} 个收藏表情生成标签…`)

    const tagged: string[] = []
    let failed = 0
    for (const [index, face] of pending.entries()) {
      // 插件卸载后停止标注，不再消耗模型额度。
      if (labeler.signal.aborted) {
        logger.info("表情标注已中止")
        return
      }
      const tag = await labeler.labelFace(face)
      const key = favoriteKey(face)
      const id = key ? idByKey.get(key) : undefined
      if (tag) tagged.push(`${id ?? "?"}. ${tag}`)
      else failed += 1
      const done = index + 1
      if (done % 5 === 0 && done < pending.length) {
        await report(target, `进度 ${done}/${pending.length}…`)
      }
    }

    const lines = [`标注完成：成功 ${tagged.length} / ${pending.length}`]
    if (tagged.length > 0) {
      lines.push(...tagged)
    }
    if (failed > 0) lines.push(`有 ${failed} 个表情没有标注成功。`)
    await report(target, lines.join("\n"))
  }

  const run = async (target: ChatTarget, text: string): Promise<void> => {
    const action = parseEmojiLabelArgs(text)
    if (action === "usage") {
      await report(target, EMOJI_LABEL_USAGE)
      return
    }
    if (action === "list") {
      const faces = await favorites.list({ refresh: true })
      const rows = await favoriteIndex.sync(faces)
      await report(target, formatFavoriteList(rows))
      return
    }
    if (running) {
      await report(target, "已经有标注任务在跑了，请等它结束。")
      return
    }
    running = true
    // 标注可能要跑很久，放到后台执行，结果用 QQ 消息回。
    void runLabeling(target, action)
      .catch((error: unknown) => {
        logger.error("表情标注任务失败", error)
        return report(target, `标注失败：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        running = false
      })
  }

  return { run }
}

/** 表情命令的用法行，`/help` 直接复用。 */
const EMOJI_LABEL_USAGE_LINES = [
  "/emoji-label all — 重新标注全部收藏表情",
  "/emoji-label inc — 只标注还没有标签的收藏表情",
  "/emoji-label list — 列出收藏表情的编号与标签",
]

/**
 * 把表情命令接进共享命令表。
 *
 * TUI 侧注册成 `/qq-emoji-label`，QQ 私聊里是 `/emoji-label`；
 * 命令自己负责边跑边发进度，所以 `run` 不返回文本。
 */
export function emojiCommand(runner: EmojiCommandRunner): CommandDefinition {
  return {
    name: EMOJI_LABEL_COMMAND,
    description:
      "给收藏表情（表情包）生成中文标签：all 全部重标，inc 只补新的，list 列出编号与标签。",
    usage: EMOJI_LABEL_USAGE_LINES,
    run: async (context, args) => {
      await runner.run(context.target, args.join(" "))
    },
  }
}
