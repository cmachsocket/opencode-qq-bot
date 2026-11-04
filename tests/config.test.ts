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

  it("enables exactly the groups declared in opencode.json", () => {
    const raw = JSON.parse(readFileSync(new URL("../opencode.json", import.meta.url), "utf8"))
    const options = raw.plugins.find((entry: { package: string }) => entry.package === "./").options
    const config = resolveConfig(options, ENV)
    expect(config.groups).toEqual([1093424135])
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

  it("merges nested proactive options with the defaults", () => {
    const config = resolveConfig({ proactive: { enabled: false } }, ENV)
    expect(config.proactive.enabled).toBe(false)
    expect(config.proactive.tickSeconds).toBe(DEFAULT_CONFIG.proactive.tickSeconds)
  })
})
