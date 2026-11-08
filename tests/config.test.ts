import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { DEFAULT_CONFIG, resolveConfig } from "../src/config"

const ENV = { NAPCAT_WS_URL: "ws://127.0.0.1:3001" }

describe("resolveConfig", () => {
  it("refuses to start without a NapCat endpoint", () => {
    expect(() => resolveConfig({}, {})).toThrow(/NAPCAT_WS_URL/)
  })

  it("falls back to defaults when nothing else is configured", () => {
    const config = resolveConfig({}, ENV)
    expect(config.napcat.url).toBe(ENV.NAPCAT_WS_URL)
    expect(config.napcat.token).toBeUndefined()
    expect(config.groups).toEqual([])
    expect(config.users).toEqual([])
    expect(config.sendDelayMs).toBe(DEFAULT_CONFIG.sendDelayMs)
    expect(config.reminder.max).toBe(DEFAULT_CONFIG.reminder.max)
  })

  it("默认的长度告警阈值不会让正常回复一直告警", () => {
    expect(DEFAULT_CONFIG.warnLength).toBe(500)
    expect(resolveConfig({}, ENV).warnLength).toBe(500)
  })

  it("把 owner 自动加进可对话私聊，并解析管理员列表", () => {
    const config = resolveConfig({}, { ...ENV, QQ_OWNER_QQ: "200", QQ_ADMINS: "300,301" })
    expect(config.ownerQQ).toBe(200)
    expect(config.admins).toEqual([300, 301])
    expect(config.users).toContain(200)
  })

  it("不回退被写坏的 owner 或管理员配置", () => {
    const config = resolveConfig({}, { ...ENV, QQ_OWNER_QQ: "abc", QQ_ADMINS: "300" })
    expect(config.ownerQQ).toBeUndefined()
    expect(config.users).toEqual([])
    expect(config.admins).toEqual([300])
  })

  it("takes the token from the environment", () => {
    const config = resolveConfig({}, { ...ENV, NAPCAT_WS_TOKEN: "from-env" })
    expect(config.napcat.token).toBe("from-env")
  })

  it("prefers plugin options over environment variables", () => {
    const config = resolveConfig(
      { napcat: { url: "ws://plugin:3001", token: "from-option" }, sendDelayMs: 10 },
      { ...ENV, NAPCAT_WS_TOKEN: "from-env", QQ_SEND_DELAY_MS: "20" },
    )
    expect(config.napcat.url).toBe("ws://plugin:3001")
    expect(config.napcat.token).toBe("from-option")
    expect(config.sendDelayMs).toBe(10)
  })

  it("enables exactly the groups declared in the config template", () => {
    const raw = JSON.parse(
      readFileSync(new URL("../opencode.example.json", import.meta.url), "utf8"),
    )
    const options = raw.plugins.find((entry: { package: string }) => entry.package === "./").options
    const config = resolveConfig(options, ENV)
    expect(config.groups).toEqual(options.groups)
    expect(config.users).toEqual(options.users)
  })

  it("reads groups from the environment as a comma separated list", () => {
    const config = resolveConfig({}, { ...ENV, QQ_TARGET_GROUPS: "123, 456 ,abc,789" })
    expect(config.groups).toEqual([123, 456, 789])
  })

  it("reads private chat users from the environment", () => {
    const config = resolveConfig({}, { ...ENV, QQ_TARGET_USERS: "321, 654 ,abc,987" })
    expect(config.users).toEqual([321, 654, 987])
  })

  it("reads groups from plugin options as an array", () => {
    const config = resolveConfig({ groups: [1, 2] }, { ...ENV, QQ_TARGET_GROUPS: "999" })
    expect(config.groups).toEqual([1, 2])
  })

  it("reads private chat users from plugin options as an array", () => {
    const config = resolveConfig({ users: [3, 4] }, { ...ENV, QQ_TARGET_USERS: "999" })
    expect(config.users).toEqual([3, 4])
  })

  it("keeps every target closed when the option list is empty", () => {
    const config = resolveConfig(
      { groups: [], users: [] },
      {
        ...ENV,
        QQ_TARGET_GROUPS: "999",
        QQ_TARGET_USERS: "999",
      },
    )
    expect(config.groups).toEqual([])
    expect(config.users).toEqual([])
  })

  it("parses the model reference from the environment", () => {
    const config = resolveConfig({}, { ...ENV, QQ_BOT_MODEL: "openai/gpt-4o/mini" })
    expect(config.model).toEqual({ providerID: "openai", id: "gpt-4o", variant: "mini" })
  })

  it("ignores an incomplete model reference", () => {
    const config = resolveConfig({}, { ...ENV, QQ_BOT_MODEL: "openai" })
    expect(config.model).toBeUndefined()
  })

  it("reads boolean environment variables as strings", () => {
    const config = resolveConfig(
      {},
      {
        ...ENV,
        QQ_REUSE_SESSION: "true",
        QQ_PROACTIVE_ENABLED: "false",
        QQ_REMINDER_ENABLED: "false",
      },
    )
    expect(config.reuseSession).toBe(true)
    expect(config.proactive.enabled).toBe(false)
    expect(config.reminder.enabled).toBe(false)
  })

  it("accepts the common boolean spellings", () => {
    for (const raw of ["1", "true", "TRUE", "yes", "on"]) {
      expect(resolveConfig({}, { ...ENV, QQ_REUSE_SESSION: raw }).reuseSession).toBe(true)
    }
    for (const raw of ["0", "false", "FALSE", "no", "off"]) {
      expect(resolveConfig({}, { ...ENV, QQ_REUSE_SESSION: raw }).reuseSession).toBe(false)
    }
  })

  it("reads numeric environment variables as strings", () => {
    const config = resolveConfig(
      {},
      {
        ...ENV,
        QQ_SEND_DELAY_MS: "250",
        QQ_WARN_LENGTH: "80",
        QQ_PROACTIVE_SILENCE_SECONDS: "60",
        QQ_PROACTIVE_P_START: "0.5",
        QQ_PROACTIVE_P_SLOPE_PER_HOUR: "0.2",
        QQ_PROACTIVE_TICK_SECONDS: "120",
        QQ_REMINDER_MAX: "5",
      },
    )
    expect(config.sendDelayMs).toBe(250)
    expect(config.warnLength).toBe(80)
    expect(config.proactive.silenceThresholdSeconds).toBe(60)
    expect(config.proactive.startProbability).toBe(0.5)
    expect(config.proactive.probabilityPerHour).toBe(0.2)
    expect(config.proactive.tickSeconds).toBe(120)
    expect(config.reminder.max).toBe(5)
  })

  it("falls back to the defaults for malformed environment values", () => {
    const config = resolveConfig(
      {},
      { ...ENV, QQ_SEND_DELAY_MS: "abc", QQ_REUSE_SESSION: "maybe", QQ_REMINDER_MAX: "" },
    )
    expect(config.sendDelayMs).toBe(DEFAULT_CONFIG.sendDelayMs)
    expect(config.reuseSession).toBe(DEFAULT_CONFIG.reuseSession)
    expect(config.reminder.max).toBe(DEFAULT_CONFIG.reminder.max)
  })

  it("reports malformed environment values", () => {
    const warnings: string[] = []
    resolveConfig({}, { ...ENV, QQ_SEND_DELAY_MS: "abc", QQ_REUSE_SESSION: "maybe" }, (message) =>
      warnings.push(message),
    )
    expect(warnings).toHaveLength(2)
    expect(warnings.join("\n")).toContain("QQ_SEND_DELAY_MS")
    expect(warnings.join("\n")).toContain("QQ_REUSE_SESSION")
  })

  it("reports an invalid model reference", () => {
    const warnings: string[] = []
    const config = resolveConfig({}, { ...ENV, QQ_BOT_MODEL: "openai" }, (message) =>
      warnings.push(message),
    )
    expect(config.model).toBeUndefined()
    expect(warnings.join("\n")).toContain("QQ_BOT_MODEL")
  })

  it("rejects a non positive heartbeat interval", () => {
    const warnings: string[] = []
    const config = resolveConfig({ proactive: { tickSeconds: 0 } }, ENV, (message) =>
      warnings.push(message),
    )
    expect(config.proactive.tickSeconds).toBe(DEFAULT_CONFIG.proactive.tickSeconds)
    expect(warnings.join("\n")).toContain("tickSeconds")
  })

  it("merges nested proactive options with the defaults", () => {
    const config = resolveConfig({ proactive: { enabled: false } }, ENV)
    expect(config.proactive.enabled).toBe(false)
    expect(config.proactive.tickSeconds).toBe(DEFAULT_CONFIG.proactive.tickSeconds)
  })

  it("keeps the location alive by default", () => {
    const config = resolveConfig({}, ENV)
    expect(config.keepAlive.enabled).toBe(true)
    expect(config.keepAlive.seconds).toBe(DEFAULT_CONFIG.keepAlive.seconds)
    expect(config.keepAlive.seconds).toBeLessThan(3600)
  })

  it("reads the keep alive options from the environment", () => {
    const config = resolveConfig(
      {},
      { ...ENV, QQ_KEEP_ALIVE_ENABLED: "false", QQ_KEEP_ALIVE_SECONDS: "600" },
    )
    expect(config.keepAlive.enabled).toBe(false)
    expect(config.keepAlive.seconds).toBe(600)
  })

  it("rejects a non positive keep alive interval", () => {
    const warnings: string[] = []
    const config = resolveConfig({ keepAlive: { seconds: 0 } }, ENV, (message) =>
      warnings.push(message),
    )
    expect(config.keepAlive.seconds).toBe(DEFAULT_CONFIG.keepAlive.seconds)
    expect(warnings.join("\n")).toContain("keepAlive.seconds")
  })

  it("merges nested keep alive options with the defaults", () => {
    const config = resolveConfig({ keepAlive: { enabled: false } }, ENV)
    expect(config.keepAlive.enabled).toBe(false)
    expect(config.keepAlive.seconds).toBe(DEFAULT_CONFIG.keepAlive.seconds)
  })

  it("reads the outbound rate limit options from the environment", () => {
    const config = resolveConfig(
      {},
      {
        ...ENV,
        QQ_RATE_MAX_PER_MINUTE: "3",
        QQ_RATE_MAX_PER_HOUR: "30",
        QQ_RATE_MIN_GAP_MS: "500",
      },
    )
    expect(config.rateLimit.maxPerMinute).toBe(3)
    expect(config.rateLimit.maxPerHour).toBe(30)
    expect(config.rateLimit.minGapMs).toBe(500)
  })

  it("merges nested rate limit options with the defaults", () => {
    const config = resolveConfig({ rateLimit: { maxPerMinute: 2 } }, ENV)
    expect(config.rateLimit.maxPerMinute).toBe(2)
    expect(config.rateLimit.maxPerHour).toBe(DEFAULT_CONFIG.rateLimit.maxPerHour)
    expect(config.rateLimit.minGapMs).toBe(DEFAULT_CONFIG.rateLimit.minGapMs)
  })

  it("rejects negative rate limit options", () => {
    const warnings: string[] = []
    const config = resolveConfig(
      { rateLimit: { maxPerMinute: -1, minGapMs: -10 } },
      ENV,
      (message) => warnings.push(message),
    )
    expect(config.rateLimit.maxPerMinute).toBe(DEFAULT_CONFIG.rateLimit.maxPerMinute)
    expect(config.rateLimit.minGapMs).toBe(DEFAULT_CONFIG.rateLimit.minGapMs)
    expect(warnings.join("\n")).toContain("rateLimit.maxPerMinute")
    expect(warnings.join("\n")).toContain("rateLimit.minGapMs")
  })

  it("deduplicates groups and warns about invalid entries", () => {
    const warnings: string[] = []
    const config = resolveConfig({ groups: [1, 1, -2, 3] }, ENV, (message) =>
      warnings.push(message),
    )
    expect(config.groups).toEqual([1, 3])
    expect(warnings.join("\n")).toContain("非法群号")
  })

  it("deduplicates users and warns about invalid entries", () => {
    const warnings: string[] = []
    const config = resolveConfig({ users: [1, 1, -2, 3] }, ENV, (message) => warnings.push(message))
    expect(config.users).toEqual([1, 3])
    expect(warnings.join("\n")).toContain("非法QQ 号")
  })

  it("falls back for out of range numeric options", () => {
    const warnings: string[] = []
    const config = resolveConfig(
      {
        warnLength: 0,
        reminder: { max: -1 },
        proactive: { startProbability: 2, probabilityPerHour: -0.1 },
      },
      ENV,
      (message) => warnings.push(message),
    )
    expect(config.warnLength).toBe(DEFAULT_CONFIG.warnLength)
    expect(config.reminder.max).toBe(DEFAULT_CONFIG.reminder.max)
    expect(config.proactive.startProbability).toBe(DEFAULT_CONFIG.proactive.startProbability)
    expect(config.proactive.probabilityPerHour).toBe(DEFAULT_CONFIG.proactive.probabilityPerHour)
    expect(warnings).toHaveLength(4)
  })

  it("warns about unknown plugin options", () => {
    const warnings: string[] = []
    resolveConfig({ unknown: true, proactive: { typo: 1 } }, ENV, (message) =>
      warnings.push(message),
    )
    expect(warnings.join("\n")).toContain("unknown")
    expect(warnings.join("\n")).toContain("proactive.typo")
  })

  it("emits warnings before throwing for a missing URL", () => {
    const warnings: string[] = []
    expect(() =>
      resolveConfig({ sendDelayMs: "abc" }, {}, (message) => warnings.push(message)),
    ).toThrow(/NAPCAT_WS_URL/)
    expect(warnings.join("\n")).toContain("sendDelayMs")
  })

  it("does not expose mutable default references", () => {
    const config = resolveConfig({}, ENV)
    config.proactive.startProbability = 0.9
    config.rateLimit.maxPerMinute = 99
    expect(DEFAULT_CONFIG.proactive.startProbability).not.toBe(0.9)
    expect(DEFAULT_CONFIG.rateLimit.maxPerMinute).not.toBe(99)
  })

  it("defaults to sensitive blocking and allows turning it off", () => {
    expect(resolveConfig({}, ENV).sensitive.enabled).toBe(true)
    expect(resolveConfig({ sensitive: { enabled: false } }, ENV).sensitive.enabled).toBe(false)
    expect(resolveConfig({}, { ...ENV, QQ_SENSITIVE_ENABLED: "0" }).sensitive.enabled).toBe(false)
  })

  it("reads the allowed media directories from the environment", () => {
    const config = resolveConfig(
      {},
      { ...ENV, QQ_MEDIA_ALLOWED_DIRS: "/srv/library, ~/Pictures/qq-bot" },
    )
    expect(config.media.allowedDirs).toEqual(["/srv/library", "~/Pictures/qq-bot"])
  })

  it("reads the allowed media directories from plugin options", () => {
    const config = resolveConfig({ media: { allowedDirs: ["/srv/library"] } }, ENV)
    expect(config.media.allowedDirs).toEqual(["/srv/library"])
  })

  it("keeps every media directory closed by default", () => {
    expect(resolveConfig({}, ENV).media.allowedDirs).toEqual([])
  })
})
