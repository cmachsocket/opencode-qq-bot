import { describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin"
import {
  EMOJI_LABEL_USAGE,
  formatFavoriteList,
  parseEmojiLabelArgs,
  registerEmojiCommand,
  resolveCommandTarget,
  selectFacesToLabel,
} from "../src/emoji/command"
import { faceName, QQ_FACE_NAMES, renderFace } from "../src/emoji/faces"
import { type CustomFace, type FavoriteRow } from "../src/emoji/favorites"
import { FavoriteIndex, favoriteKey, type IndexStorage } from "../src/emoji/favorite-index"
import { cleanTag, MAX_TAG_LENGTH } from "../src/emoji/label"
import { DEFAULT_CONFIG, type QQBotConfig } from "../src/config"
import type { ChatTarget } from "../src/chat"
import type { Logger } from "../src/logger"
import type { QQClient } from "../src/naplink/client"
import type { SessionManager } from "../src/session/manager"

const face = (desc: string, extra: Partial<CustomFace> = {}): CustomFace => {
  const resId = extra.resId ?? "res-1"
  return {
    emoId: 1,
    resId,
    url: "https://example.com/a.png",
    // md5 是身份依据，默认跟着 resId 走，避免多条记录被当成同一张图。
    md5: `md5-${resId}`,
    desc,
    ...extra,
  }
}

describe("cleanTag", () => {
  it("keeps the first non-empty line", () => {
    expect(cleanTag("\n\n猫猫摊手\n这是解释")).toBe("猫猫摊手")
  })

  it("removes quotes and punctuation", () => {
    expect(cleanTag("“猫猫摊手！”")).toBe("猫猫摊手")
    expect(cleanTag("「猫猫摊手」")).toBe("猫猫摊手")
    expect(cleanTag("猫猫摊手（摊手）")).toBe("猫猫摊手摊手")
  })

  it("removes markdown and list decorations", () => {
    expect(cleanTag("- 猫猫摊手")).toBe("猫猫摊手")
    expect(cleanTag("1. 猫猫摊手")).toBe("猫猫摊手")
    expect(cleanTag("**猫猫摊手**")).toBe("猫猫摊手")
    expect(cleanTag("# 猫猫摊手")).toBe("猫猫摊手")
  })

  it("truncates to the maximum length", () => {
    const long = "一二三四五六七八九十一二三四五六七八九十"
    expect(cleanTag(long)).toHaveLength(MAX_TAG_LENGTH)
    expect(cleanTag(long)).toBe("一二三四五六七八九十一二")
  })

  it("returns an empty string for unusable output", () => {
    expect(cleanTag("   ")).toBe("")
    expect(cleanTag("！？。")).toBe("")
  })
})

describe("FavoriteIndex", () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger

  function createStorage(): { storage: IndexStorage; map: Map<string, unknown> } {
    const map = new Map<string, unknown>()
    const storage = {
      get: async (key: string) => map.get(key),
      set: async (key: string, value: unknown) => {
        map.set(key, value)
      },
    } as unknown as IndexStorage
    return { storage, map }
  }

  it("uses md5 as the absolute identity key", () => {
    expect(favoriteKey({ resId: "res-1", md5: "MD5-1", emoId: 3 })).toBe("md5:md5-1")
    expect(favoriteKey({ resId: "res-1", emoId: 3 })).toBe("res:res-1")
    expect(favoriteKey({ emoId: 3 })).toBe("emo:3")
    expect(favoriteKey({})).toBeUndefined()
  })

  it("dedupes faces sharing the same md5", async () => {
    const { storage } = createStorage()
    const index = new FavoriteIndex(storage, logger)
    const rows = await index.sync([
      face("猫猫摊手", { emoId: 0, resId: "res-0", md5: "same" }),
      face("猫猫摊手", { emoId: 1, resId: "res-1", md5: "same" }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(1)
  })

  it("keeps the id when res_id changes but md5 stays", async () => {
    const { storage } = createStorage()
    const index = new FavoriteIndex(storage, logger)
    const first = await index.sync([
      face("猫猫摊手", { emoId: 0, resId: "res-0", md5: "md5-fixed" }),
    ])
    const again = await index.sync([
      face("猫猫摊手", { emoId: 5, resId: "res-changed", md5: "md5-fixed" }),
    ])
    expect(first[0]?.id).toBe(1)
    expect(again[0]?.id).toBe(1)
  })

  it("assigns ids from one and keeps them stable", async () => {
    const { storage } = createStorage()
    const index = new FavoriteIndex(storage, logger)
    const rows = await index.sync([
      face("猫猫摊手", { emoId: 0, resId: "res-0" }),
      face("狗狗奔跑", { emoId: 1, resId: "res-1" }),
    ])
    expect(rows.map((row) => row.id)).toEqual([1, 2])
    expect(rows[0]?.tag).toBe("猫猫摊手")

    // emo_id 变了也不影响编号。
    const again = await index.sync([
      face("猫猫摊手", { emoId: 9, resId: "res-0" }),
      face("狗狗奔跑", { emoId: 8, resId: "res-1" }),
    ])
    expect(again.map((row) => row.id)).toEqual([1, 2])
  })

  it("survives a restart with the same storage", async () => {
    const { storage } = createStorage()
    await new FavoriteIndex(storage, logger).sync([face("猫猫摊手", { resId: "res-0" })])
    const restored = await new FavoriteIndex(storage, logger).sync([
      face("猫猫摊手", { resId: "res-0" }),
    ])
    expect(restored[0]?.id).toBe(1)
  })

  it("does not reuse the id of a removed face", async () => {
    const { storage } = createStorage()
    const index = new FavoriteIndex(storage, logger)
    await index.sync([face("猫猫摊手", { resId: "res-0" })])
    const rows = await index.sync([face("新表情", { resId: "res-new" })])
    expect(rows[0]?.id).toBe(2)
  })

  it("resolves a face by id", async () => {
    const { storage } = createStorage()
    const index = new FavoriteIndex(storage, logger)
    const faces = [face("猫猫摊手", { resId: "res-0" })]
    const row = await index.resolve(faces, 1)
    expect(row?.face.desc).toBe("猫猫摊手")
    expect(await index.resolve(faces, 99)).toBeUndefined()
  })
})

describe("QQ official faces", () => {
  it("maps known face ids to their names", () => {
    expect(faceName("4")).toBe("得意")
    expect(faceName(14)).toBe("微笑")
    expect(faceName("319")).toBe("比心")
  })

  it("returns undefined for unknown ids", () => {
    expect(faceName("999")).toBeUndefined()
  })

  it("renders known and unknown ids", () => {
    expect(renderFace("4")).toBe("[得意]")
    expect(renderFace("999")).toBe("[表情:999]")
  })

  it("only keeps numeric ids in the table", () => {
    for (const id of Object.keys(QQ_FACE_NAMES)) {
      expect(id).toMatch(/^\d+$/)
    }
  })
})

describe("parseEmojiLabelArgs", () => {
  it("parses the supported actions", () => {
    expect(parseEmojiLabelArgs("all")).toBe("all")
    expect(parseEmojiLabelArgs("inc")).toBe("inc")
    expect(parseEmojiLabelArgs("list")).toBe("list")
  })

  it("tolerates the command prefix", () => {
    expect(parseEmojiLabelArgs("/emoji-label all")).toBe("all")
    expect(parseEmojiLabelArgs("emoji-label: inc")).toBe("inc")
    expect(parseEmojiLabelArgs("/emoji-label list")).toBe("list")
  })

  it("ignores trailing words", () => {
    expect(parseEmojiLabelArgs("all 重新标注")).toBe("all")
  })

  it("falls back to the usage text", () => {
    expect(parseEmojiLabelArgs("")).toBe("usage")
    expect(parseEmojiLabelArgs("nope")).toBe("usage")
  })
})

describe("selectFacesToLabel", () => {
  const faces = [face(""), face("猫猫摊手"), face("")]

  it("only picks untagged faces in incremental mode", () => {
    const selected = selectFacesToLabel(faces, "inc")
    expect(selected).toHaveLength(2)
    expect(selected.every((item) => !item.desc)).toBe(true)
  })

  it("picks every face in full mode", () => {
    expect(selectFacesToLabel(faces, "all")).toHaveLength(3)
  })
})

describe("formatFavoriteList", () => {
  const row = (id: number, tag: string): FavoriteRow => ({
    id,
    face: { emoId: id - 1, desc: tag },
    tag,
  })

  it("lists every face with its id", () => {
    const text = formatFavoriteList([row(1, "猫猫摊手"), row(2, ""), row(3, "狗狗奔跑")])
    expect(text).toBe(
      "收藏表情（编号即发送用的 id，共 3 个）\n1. 猫猫摊手\n2. （未标注）\n3. 狗狗奔跑",
    )
  })

  it("reports an empty list", () => {
    expect(formatFavoriteList([])).toBe("没有读取到收藏表情。")
  })
})

interface CommandHarness {
  execute: (text: string, sessionID?: string) => Promise<void>
  api: {
    sendGroupMessage: SendMock
    sendPrivateMessage: SendMock
  }
  labelFace: LabelMock
  manager: { targetForSession: ReturnType<typeof vi.fn> }
}

const createSendMock = () => vi.fn(async (_id: number, _content: string) => ({}))
const createLabelMock = () => vi.fn(async (_face: CustomFace) => "新标签")
type SendMock = ReturnType<typeof createSendMock>
type LabelMock = ReturnType<typeof createLabelMock>

async function createCommandHarness(
  options: {
    faces?: CustomFace[]
    target?: ChatTarget | undefined
    config?: Partial<QQBotConfig>
  } = {},
): Promise<CommandHarness> {
  let execute: (input: {
    sessionID: string
    prompt: { text?: string }
  }) => Promise<void> = async () => {}
  const ctx = {
    command: {
      transform: vi.fn(async (callback: (editor: unknown) => void) => {
        callback({
          add: (command: {
            name: string
            execute: (input: { sessionID: string; prompt: { text?: string } }) => Promise<void>
          }) => {
            execute = command.execute
          },
        })
        return { dispose: async () => {} }
      }),
    },
  } as unknown as Plugin.Context

  const api = {
    sendGroupMessage: createSendMock(),
    sendPrivateMessage: createSendMock(),
  }
  const labelFace = createLabelMock()
  const favorites = {
    list: vi.fn(async () => options.faces ?? []),
  }
  const storage = new Map<string, unknown>()
  const favoriteIndex = new FavoriteIndex(
    {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
    } as unknown as IndexStorage,
    {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger,
  )
  const manager = {
    targetForSession: vi.fn(() => options.target),
  }
  const config: QQBotConfig = {
    ...DEFAULT_CONFIG,
    napcat: { url: "ws://127.0.0.1:3001" },
    groups: [100],
    users: [200],
    sendDelayMs: 0,
    ...options.config,
  }

  await registerEmojiCommand({
    ctx,
    config,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger,
    manager: manager as unknown as SessionManager,
    client: { api } as unknown as QQClient,
    favorites: favorites as never,
    favoriteIndex,
    labeler: { labelFace } as never,
  })

  return {
    execute: (text, sessionID = "session-1") => execute({ sessionID, prompt: { text } }),
    api,
    labelFace,
    manager,
  }
}

describe("resolveCommandTarget", () => {
  it("uses the bound target", () => {
    const target: ChatTarget = { kind: "group", id: 100 }
    const config: QQBotConfig = {
      ...DEFAULT_CONFIG,
      napcat: { url: "ws://127.0.0.1:3001" },
      groups: [100],
      users: [200],
    }
    const manager = { targetForSession: () => target } as unknown as SessionManager
    expect(resolveCommandTarget({ config, manager }, "session-1")).toEqual(target)
  })

  it("falls back to the first configured target", () => {
    const config: QQBotConfig = {
      ...DEFAULT_CONFIG,
      napcat: { url: "ws://127.0.0.1:3001" },
      groups: [100],
      users: [200],
    }
    const manager = { targetForSession: () => undefined } as unknown as SessionManager
    expect(resolveCommandTarget({ config, manager }, "session-1")).toEqual({
      kind: "group",
      id: 100,
    })
  })
})

describe("registerEmojiCommand", () => {
  it("sends the usage text over QQ", async () => {
    const harness = await createCommandHarness()
    await harness.execute("")
    expect(harness.api["sendGroupMessage"]).toHaveBeenCalledWith(100, EMOJI_LABEL_USAGE)
  })

  it("sends the label list over QQ", async () => {
    const harness = await createCommandHarness({
      faces: [
        face("猫猫摊手", { emoId: 0, resId: "res-0" }),
        face("", { emoId: 1, resId: "res-1" }),
      ],
    })
    await harness.execute("list")
    expect(harness.api["sendGroupMessage"]).toHaveBeenCalledWith(
      100,
      "收藏表情（编号即发送用的 id，共 2 个）\n1. 猫猫摊手\n2. （未标注）",
    )
  })

  it("labels every face in full mode", async () => {
    const harness = await createCommandHarness({
      faces: [
        face("猫猫摊手", { emoId: 0, resId: "res-0" }),
        face("狗狗奔跑", { emoId: 1, resId: "res-1" }),
      ],
    })
    await harness.execute("all")
    await vi.waitFor(() => {
      expect(harness.labelFace).toHaveBeenCalledTimes(2)
    })
    await vi.waitFor(() => {
      const texts = harness.api["sendGroupMessage"].mock.calls.map((call) => call[1])
      expect(texts.some((text: string) => text.includes("标注完成：成功 2 / 2"))).toBe(true)
      // 标签前面带的是插件自己维护的编号。
      expect(texts.some((text: string) => text.includes("1. 新标签"))).toBe(true)
      expect(texts.some((text: string) => text.includes("2. 新标签"))).toBe(true)
    })
  })

  it("only labels untagged faces in incremental mode", async () => {
    const harness = await createCommandHarness({ faces: [face("猫猫摊手"), face("")] })
    await harness.execute("inc")
    await vi.waitFor(() => {
      expect(harness.labelFace).toHaveBeenCalledTimes(1)
    })
    expect(harness.labelFace.mock.calls[0]?.[0]).toMatchObject({ desc: "" })
  })
})
