import type { Plugin } from "@opencode/plugin"
import type { Logger } from "../logger"

/** 会话列表最多翻几页。 */
const MAX_PAGES = 20
/** 每页抓多少条。 */
const PAGE_SIZE = 200

type ListResult = Awaited<ReturnType<Plugin.Context["session"]["list"]>>
/** 会话列表里的单条会话。 */
export type ListedSession = ListResult["data"][number]

/** 查找会话时的可调项。 */
export interface FindOptions {
  /** 最多返回多少个命中的会话。 */
  limit?: number
  /** 最多翻几页。 */
  maxPages?: number
  /** 每页抓多少条。 */
  pageSize?: number
}

/**
 * 在指定目录下按谓词查找会话。
 *
 * 列表按创建时间倒序、翻页上限固定，避免会话很多时把整个列表拉一遍。
 *
 * @returns 命中的会话；找不到或查询失败时返回空数组。
 */
export async function findSessions(
  ctx: Plugin.Context,
  directory: NonNullable<Parameters<Plugin.Context["session"]["list"]>[0]>["directory"],
  match: (session: ListedSession) => boolean,
  logger: Logger,
  failure: string,
  options: FindOptions = {},
): Promise<ListedSession[]> {
  const limit = options.limit ?? 1
  const maxPages = options.maxPages ?? MAX_PAGES
  const pageSize = options.pageSize ?? PAGE_SIZE
  const found: ListedSession[] = []
  let cursor: ListResult["cursor"]["next"] | undefined
  try {
    for (let page = 0; page < maxPages && found.length < limit; page += 1) {
      const result = await ctx.session.list({
        directory,
        limit: pageSize,
        order: "desc",
        ...(cursor ? { cursor } : {}),
      })
      for (const session of result.data) {
        if (!match(session)) continue
        found.push(session)
        if (found.length >= limit) break
      }
      cursor = result.cursor.next ?? undefined
      if (!cursor) break
    }
  } catch (error) {
    logger.warn(failure, error)
  }
  return found
}

/**
 * 在指定目录下按谓词查找第一个会话。
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
  const [first] = await findSessions(ctx, directory, match, logger, failure, { limit: 1 })
  return first?.id
}
