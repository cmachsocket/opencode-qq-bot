import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("..", import.meta.url))
const read = (name: string): string => readFileSync(join(root, name), "utf8")

interface PackageJson {
  license?: string
  dependencies?: Record<string, string>
}

const pkg = JSON.parse(read("package.json")) as PackageJson
const license = read("LICENSE")
const notice = read("NOTICE")

describe("许可证与 NOTICE", () => {
  it("package.json 使用 CC-BY-NC-SA-4.0", () => {
    expect(pkg.license).toBe("CC-BY-NC-SA-4.0")
  })

  it("LICENSE 写明 CC BY-NC-SA 4.0", () => {
    expect(license).toContain("CC BY-NC-SA 4.0")
    expect(license).toContain("Attribution-NonCommercial-ShareAlike 4.0 International")
  })

  it("NOTICE 的依赖表覆盖全部运行时依赖", () => {
    const missing = Object.keys(pkg.dependencies ?? {}).filter(
      (dep) => !new RegExp(`^\\|\\s*${dep.replace(/\./g, "\\.")}\\s*\\|`, "m").test(notice),
    )
    expect(missing).toEqual([])
  })

  it("NOTICE 带 MIT 许可全文", () => {
    expect(notice).toContain("Permission is hereby granted, free of charge")
    expect(notice).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
  })
})
