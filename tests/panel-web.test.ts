import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const read = (name: string): string => readFileSync(join(root, name), "utf8")

/**
 * 面板的 CSP 是 `script-src 'self'`，浏览器里不能 eval；用 `new Function` 编译校验器的库
 * （ajv 就是）会让保存按钮静默失败：`void save()` 把 `EvalError` 吞成未处理的拒绝。
 */
describe("面板前端不做本地校验", () => {
  it("前端依赖与配置页都不使用 ajv", () => {
    const pkg = JSON.parse(read("web/package.json")) as {
      dependencies?: Record<string, string>
    }
    expect(pkg.dependencies?.ajv).toBeUndefined()
    expect(read("web/src/routes/ConfigPage.svelte")).not.toMatch(/from "ajv"/)
  })
})

/**
 * 两个独立配置文件各有自己的页面。
 * 校验规则只在后端：前端只负责把服务端返回的逐字段原因显示出来。
 */
describe("独立配置页面", () => {
  const pages = [
    { file: "web/src/routes/ChatOverridesPage.svelte", call: "api.chatOverrides" },
    { file: "web/src/routes/ToolProfilesPage.svelte", call: "api.toolProfiles" },
  ]

  it("会话覆盖与工具档案是配置页之外的独立标签页", () => {
    const app = read("web/src/App.svelte")
    expect(app).toContain('<Tabs.Trigger value="chat-overrides">会话覆盖</Tabs.Trigger>')
    expect(app).toContain('<Tabs.Trigger value="tool-profiles">工具档案</Tabs.Trigger>')
    expect(app).toContain("ChatOverridesPage")
    expect(app).toContain("ToolProfilesPage")
  })

  it("两个页面都从面板接口取数与保存", () => {
    for (const page of pages) {
      const source = read(page.file)
      expect(source).toContain(page.call)
      expect(source).toMatch(/api\.save(ChatOverrides|ToolProfiles)\(/)
      expect(source).not.toMatch(/from "ajv"/)
    }
  })

  it("校验失败时展示服务端返回的逐字段原因", () => {
    for (const page of pages) {
      const source = read(page.file)
      // 服务端返回 fields[].path / fields[].message，页面就地显示，不自己判对错。
      expect(source).toMatch(/cause\.fields/)
      expect(source).toMatch(/errorFor\(/)
    }
  })

  it("会话覆盖页面只编辑 ChatOverride 里有的字段", () => {
    const source = read("web/src/routes/ChatOverridesPage.svelte")
    for (const field of [
      "wake",
      "wake.prefixes",
      "proactive.enabled",
      "proactive.startProbability",
      "collect.privateMs",
      "collect.groupMs",
      "agent",
      "model",
      "soulPath",
      "soulName",
    ]) {
      expect(source).toContain(`"${field}"`)
    }
  })
})
