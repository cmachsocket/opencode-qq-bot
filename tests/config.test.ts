import { describe, expect, it } from "vitest"
import { CONFIG_FIELDS, CONFIG_GROUPS } from "../src/config/fields"
import {
  applyHotFields,
  configJsonSchema,
  createStrictFieldSchema,
  DEFAULT_CONFIG,
  FILE_KEYS,
  resolveConfig,
} from "../src/config"

/** 递归取对象里的值。 */
function at(target: unknown, path: string): unknown {
  let current: unknown = target
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** 只放一个 NapCat 地址的最小配置。 */
const BASE = { napcat: { url: "ws://127.0.0.1:3001" } }

describe("字段注册表", () => {
  it("字段路径唯一", () => {
    const paths = CONFIG_FIELDS.map((field) => field.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it("字段都归在一个已知分组里", () => {
    const groups = new Set(CONFIG_GROUPS.map((group) => group.id))
    for (const field of CONFIG_FIELDS) {
      expect(groups.has(field.group), `${field.path} 的分组 ${field.group} 未定义`).toBe(true)
    }
  })

  it("注册表与 DEFAULT_CONFIG 一致", () => {
    for (const field of CONFIG_FIELDS) {
      expect(at(DEFAULT_CONFIG, field.path), `${field.path} 的默认值不一致`).toEqual(field.default)
    }
  })

  it("注册表与配置文件键集合一致", () => {
    const expected = new Map<string, Set<string>>()
    for (const field of CONFIG_FIELDS) {
      const segments = field.path.split(".")
      for (let index = 0; index < segments.length; index += 1) {
        const prefix = segments.slice(0, index).join(".")
        const key = segments[index]
        if (key === undefined) continue
        const allowed = expected.get(prefix) ?? new Set<string>()
        allowed.add(key)
        expected.set(prefix, allowed)
      }
    }
    for (const [prefix, allowed] of expected) {
      expect([...(FILE_KEYS.get(prefix) ?? [])].sort(), `${prefix} 的键集合不一致`).toEqual(
        [...allowed].sort(),
      )
    }
    expect(FILE_KEYS.size).toBe(expected.size)
  })

  it("JSON Schema 覆盖全部字段", () => {
    const schema = configJsonSchema() as {
      properties: Record<string, { properties?: Record<string, unknown> }>
    }
    for (const field of CONFIG_FIELDS) {
      const segments = field.path.split(".")
      let current: { properties?: Record<string, unknown> } = schema
      for (const segment of segments) {
        const next = current.properties?.[segment] as
          { properties?: Record<string, unknown> } | undefined
        expect(next, `${field.path} 不在 JSON Schema 里`).toBeDefined()
        current = next ?? {}
      }
    }
  })

  it("agent 不在注册表里：它只从 opencode.json 读", () => {
    expect(CONFIG_FIELDS.some((field) => field.path === "agent")).toBe(false)
  })

  it("model 在注册表里：它是用户偏好", () => {
    const model = CONFIG_FIELDS.find((field) => field.path === "model")
    expect(model?.type).toBe("modelRef")
  })
})

describe("resolveConfig", () => {
  it("没有 NapCat 地址时拒绝启动", () => {
    expect(() => resolveConfig({})).toThrow(/napcat\.url/)
  })

  it("文件里没写的字段走默认值", () => {
    const config = resolveConfig(BASE)
    expect(config.napcat.url).toBe("ws://127.0.0.1:3001")
    expect(config.napcat.token).toBeUndefined()
    expect(config.access.allow.groups).toEqual([])
    expect(config.access.allow.users).toEqual([])
    expect(config.access.deny.groups).toEqual([])
    expect(config.access.deny.users).toEqual([])
    expect(config.access.allowAllWhenEmpty).toBe(false)
    expect(config.sendDelayMs).toBe(DEFAULT_CONFIG.sendDelayMs)
    expect(config.reminder.max).toBe(DEFAULT_CONFIG.reminder.max)
    expect(config.panel.enabled).toBe(DEFAULT_CONFIG.panel.enabled)
    expect(config.panel.host).toBe("127.0.0.1")
    expect(config.panel.port).toBe(7391)
  })

  it("每个注册表字段都能从配置里读出来", () => {
    const config = resolveConfig(BASE)
    for (const field of CONFIG_FIELDS) {
      // NapCat 地址是必填项，没有默认值。
      if (field.path === "napcat.url") continue
      expect(at(config, field.path), `${field.path} 读不到`).toEqual(field.default)
    }
    expect(config.napcat.url).toBe(BASE.napcat.url)
  })

  it("agent 只从插件选项来", () => {
    expect(resolveConfig(BASE, "builder").agent).toBe("builder")
    expect(resolveConfig(BASE).agent).toBeUndefined()
  })

  it("解析 owner 与管理员列表", () => {
    const config = resolveConfig({ ...BASE, ownerQQ: 200, admins: [300, 301] })
    expect(config.ownerQQ).toBe(200)
    expect(config.admins).toEqual([300, 301])
  })

  it("不回退被写坏的 owner", () => {
    const warnings: string[] = []
    const config = resolveConfig({ ...BASE, ownerQQ: "abc" }, undefined, (message) =>
      warnings.push(message),
    )
    expect(config.ownerQQ).toBeUndefined()
    expect(warnings.join("\n")).toContain("ownerQQ")
  })

  it("只认 message 与 notice 两个事件类别", () => {
    const warnings: string[] = []
    const config = resolveConfig(
      { ...BASE, events: { subscribe: ["message", "notice", "heartbeat"] } },
      undefined,
      (message) => warnings.push(message),
    )
    expect(config.events.subscribe).toEqual(["message", "notice"])
    expect(warnings.join("\n")).toContain("heartbeat")
  })

  it("豁免拒绝名单里的 owner 并告警", () => {
    const warnings: string[] = []
    const config = resolveConfig(
      { ...BASE, ownerQQ: 200, access: { deny: { users: [200, 300] } } },
      undefined,
      (message) => warnings.push(message),
    )
    expect(config.access.deny.users).toEqual([300])
    expect(warnings.join("\n")).toContain("豁免")
  })

  it("非法值告警并回退到默认值", () => {
    const warnings: string[] = []
    const config = resolveConfig(
      {
        ...BASE,
        sendDelayMs: "abc",
        rateLimit: { maxPerMinute: -1 },
        warnLength: 0,
        proactive: { startProbability: 2, tickSeconds: 0 },
      },
      undefined,
      (message) => warnings.push(message),
    )
    expect(config.sendDelayMs).toBe(DEFAULT_CONFIG.sendDelayMs)
    expect(config.rateLimit.maxPerMinute).toBe(DEFAULT_CONFIG.rateLimit.maxPerMinute)
    expect(config.warnLength).toBe(DEFAULT_CONFIG.warnLength)
    expect(config.proactive.startProbability).toBe(DEFAULT_CONFIG.proactive.startProbability)
    expect(config.proactive.tickSeconds).toBe(DEFAULT_CONFIG.proactive.tickSeconds)
    expect(warnings.length).toBe(5)
  })

  it("未知配置项告警但不影响生效值", () => {
    const warnings: string[] = []
    const config = resolveConfig(
      { ...BASE, unknown: true, proactive: { typo: 1 } },
      undefined,
      (message) => warnings.push(message),
    )
    expect(config.proactive.tickSeconds).toBe(DEFAULT_CONFIG.proactive.tickSeconds)
    expect(warnings.join("\n")).toContain("unknown")
    expect(warnings.join("\n")).toContain("proactive.typo")
  })

  it("不暴露可变的默认引用", () => {
    const config = resolveConfig(BASE)
    config.proactive.startProbability = 0.9
    config.rateLimit.maxPerMinute = 99
    expect(DEFAULT_CONFIG.proactive.startProbability).not.toBe(0.9)
    expect(DEFAULT_CONFIG.rateLimit.maxPerMinute).not.toBe(99)
  })

  it("敏感字段默认不回显：面板只看有没有值", () => {
    const config = resolveConfig({ ...BASE, napcat: { url: BASE.napcat.url, token: "s3cret" } })
    expect(config.napcat.token).toBe("s3cret")
  })
})

describe("热更新", () => {
  it("只有注册表里标了 hot 的字段才会立即生效", () => {
    const live = resolveConfig(BASE)
    const next = resolveConfig({
      ...BASE,
      access: { allow: { groups: [1, 2] } },
      napcat: { url: "ws://127.0.0.1:4001" },
    })
    applyHotFields(live, next)
    expect(live.access.allow.groups).toEqual([1, 2])
    // NapCat 地址是启动期读取的字段，改了也要重启。
    expect(live.napcat.url).toBe("ws://127.0.0.1:3001")
  })

  it("热更新不换掉中间对象的引用", () => {
    const live = resolveConfig(BASE)
    const access = live.access
    const next = resolveConfig({ ...BASE, access: { allowAllWhenEmpty: true } })
    applyHotFields(live, next)
    expect(live.access).toBe(access)
    expect(live.access.allowAllWhenEmpty).toBe(true)
  })

  it("热字段清单与注册表一致", () => {
    const hot = CONFIG_FIELDS.filter((field) => field.hot).map((field) => field.path)
    expect(hot).toContain("access.allow.groups")
    expect(hot).toContain("rateLimit.maxPerMinute")
    expect(hot).toContain("log.level")
    expect(hot).toContain("panel.enabled")
    expect(hot).not.toContain("napcat.url")
    expect(hot).not.toContain("diary.path")
  })
})

describe("严格校验", () => {
  const schemaFor = (path: string) => {
    const field = CONFIG_FIELDS.find((entry) => entry.path === path)
    if (!field) throw new Error(`未知字段 ${path}`)
    return createStrictFieldSchema(field)
  }

  it("接受合法取值", () => {
    expect(schemaFor("rateLimit.maxPerMinute").safeParse(3).success).toBe(true)
    expect(schemaFor("access.allow.groups").safeParse([1, 2]).success).toBe(true)
    expect(schemaFor("access.allow.groups").safeParse("1,2").success).toBe(true)
    expect(schemaFor("log.level").safeParse("debug").success).toBe(true)
    expect(schemaFor("diary.summaryTime").safeParse("23:30").success).toBe(true)
  })

  it("拒绝非法取值", () => {
    expect(schemaFor("rateLimit.maxPerMinute").safeParse(-1).success).toBe(false)
    expect(schemaFor("access.allow.groups").safeParse([0]).success).toBe(false)
    expect(schemaFor("log.level").safeParse("verbose").success).toBe(false)
    expect(schemaFor("diary.summaryTime").safeParse("25:00").success).toBe(false)
    expect(schemaFor("model").safeParse("openai").success).toBe(false)
  })
})
