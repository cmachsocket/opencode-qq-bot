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
