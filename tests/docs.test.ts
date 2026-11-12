import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CONFIG_FIELDS } from "../src/config/fields"

const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")

const configuration = read("docs/configuration.md")
const readme = read("README.md")
const panel = read("docs/panel.md")
const changelog = read("CHANGELOG.md")
const example = JSON.parse(read("opencode.example.json")) as {
  plugins: Array<{ options: Record<string, unknown> }>
}

/** 已经移除的环境变量名：文档里不该再出现。 */
const REMOVED_ENV = [
  "NAPCAT_WS_URL",
  "NAPCAT_WS_TOKEN",
  "QQ_ALLOW_GROUPS",
  "QQ_ALLOW_USERS",
  "QQ_DENY_GROUPS",
  "QQ_DENY_USERS",
  "QQ_OWNER_QQ",
  "QQ_ADMINS",
  "QQ_BOT_HOME",
  "QQ_BOT_MODEL",
  "QQ_BOT_AGENT",
  "QQ_EVENT_SUBSCRIBE",
  "QQ_LOG_LEVEL",
  "QQ_TARGET_GROUPS",
]

describe("配置来源", () => {
  it(".env.example 已删除：环境变量不再是配置来源", () => {
    expect(existsSync(new URL("../.env.example", import.meta.url))).toBe(false)
  })

  it("插件选项只剩 agent", () => {
    const options = example.plugins[0]?.options ?? {}
    expect(Object.keys(options)).toEqual(["agent"])
  })

  it("文档不再出现旧的环境变量名", () => {
    for (const name of REMOVED_ENV) {
      expect(configuration, `${name} 不该再出现在 docs/configuration.md`).not.toContain(name)
      expect(readme, `${name} 不该再出现在 README`).not.toContain(name)
    }
  })

  it("文档写明配置文件的位置", () => {
    expect(configuration).toContain("config.json")
    expect(readme).toContain("config.json")
    expect(configuration).toContain("$XDG_DATA_HOME/opencode-qq-bot/workspace")
  })
})

describe("字段表与注册表一致", () => {
  it("docs/configuration.md 覆盖全部配置项", () => {
    for (const field of CONFIG_FIELDS) {
      expect(configuration, `${field.path} 没有写进 docs/configuration.md`).toContain(
        `\`${field.path}\``,
      )
    }
  })

  it("README 的配置表覆盖全部配置项", () => {
    for (const field of CONFIG_FIELDS) {
      expect(readme, `${field.path} 没有写进 README`).toContain(`\`${field.path}\``)
    }
  })
})

describe("破坏性变更的记录", () => {
  it("CHANGELOG 记了配置来源的破坏性变更", () => {
    expect(changelog).toContain("config.json")
    expect(changelog).toMatch(/破坏性变更|BREAKING/)
  })

  it("docs/panel.md 标了实现状态", () => {
    expect(panel).toContain("已实现")
  })
})
