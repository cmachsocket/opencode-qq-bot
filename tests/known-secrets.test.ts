import { describe, expect, it } from "vitest"
import { knownSecrets } from "../src/index"
import { DEFAULT_CONFIG, type QQBotConfig } from "../src/config"

/**
 * 已知凭证的收集。
 *
 * 日志打码与出站拦截都靠这份清单：漏一个，日志文件里就多一份明文凭证。
 */
describe("已知凭证", () => {
  /** 造一份完整配置，只改关心的字段。 */
  function config(overrides: Partial<QQBotConfig> = {}): QQBotConfig {
    return {
      ...DEFAULT_CONFIG,
      napcat: { url: "ws://127.0.0.1:3001" },
      ...overrides,
    }
  }

  it("面板令牌算已知凭证", () => {
    const value = config({ panel: { ...DEFAULT_CONFIG.panel, token: "panel-token-value" } })
    expect(knownSecrets(value)).toContain("panel-token-value")
  })

  it("NapCat 令牌算已知凭证", () => {
    const value = config({ napcat: { url: "ws://127.0.0.1:3001", token: "napcat-token-value" } })
    expect(knownSecrets(value)).toContain("napcat-token-value")
  })

  it("地址查询串里的凭证也算进来", () => {
    const value = config({ napcat: { url: "ws://127.0.0.1:3001?access_token=query-token-value" } })
    expect(knownSecrets(value)).toContain("query-token-value")
  })

  it("空值不会被收进来", () => {
    expect(knownSecrets(config()).every((secret) => secret.length > 0)).toBe(true)
  })
})
