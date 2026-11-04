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
    expect(config.sendDelayMs).toBe(DEFAULT_CONFIG.sendDelayMs)
    expect(config.reminder.max).toBe(DEFAULT_CONFIG.reminder.max)
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
  })

  it("reads groups from the environment as a comma separated list", () => {
    const config = resolveConfig({}, { ...ENV, QQ_TARGET_GROUPS: "123, 456 ,abc,789" })
    expect(config.groups).toEqual([123, 456, 789])
  })

  it("reads groups from plugin options as an array", () => {
    const config = resolveConfig({ groups: [1, 2] }, { ...ENV, QQ_TARGET_GROUPS: "999" })
    expect(config.groups).toEqual([1, 2])
  })

  it("keeps every group closed when the option list is empty", () => {
    const config = resolveConfig({ groups: [] }, { ...ENV, QQ_TARGET_GROUPS: "999" })
    expect(config.groups).toEqual([])
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
        QQ_BUSY_TIMEOUT_MS: "1000",
        QQ_PROACTIVE_SILENCE_SECONDS: "60",
        QQ_PROACTIVE_P_START: "0.5",
        QQ_PROACTIVE_P_SLOPE_PER_HOUR: "0.2",
        QQ_PROACTIVE_TICK_SECONDS: "120",
        QQ_REMINDER_MAX: "5",
      },
    )
    expect(config.sendDelayMs).toBe(250)
    expect(config.warnLength).toBe(80)
    expect(config.busyTimeoutMs).toBe(1000)
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
})
