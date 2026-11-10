import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../logger"

/** 会话列表最多翻几页。 */
const MAX_PAGES = 5
/** 每页抓多少条。 */
const PAGE_SIZE = 100

type ListResult = Awaited<ReturnType<Plugin.Context["session"]["list"]>>
/** 会话列表里的单条会话。 */
export type ListedSession = ListResult["data"][number]

/**
 * 在指定目录下按谓词查找会话。
 *
 * 列表按创建时间倒序、翻页上限固定，避免会话很多时把整个列表拉一遍。
 *
 * @returns 命中的会话 ID；找不到或查询失败时返回 `undefined`。
 */
export async function findSession(
  ctx: Plugin.Context,
  directory: NonNullable<Parameters<Plugin.Context["session"]["list"]>[0]>["directory"],
  match: (session: ListedSession) => boolean,
  logger: Logger,
  failure: string,
): Promise<string | undefined> {
  let cursor: ListResult["cursor"]["next"] | undefined
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await ctx.session.list({
        directory,
        limit: PAGE_SIZE,
        order: "desc",
        ...(cursor ? { cursor } : {}),
      })
      const hit = result.data.find(match)
      if (hit) return hit.id
      cursor = result.cursor.next ?? undefined
      if (!cursor) break
    }
  } catch (error) {
    logger.warn(failure, error)
  }
  return undefined
}
