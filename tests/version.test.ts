import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { pluginVersion } from "../src/version"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string
}

describe("插件版本", () => {
  it("返回 package.json 里的版本号", () => {
    expect(pluginVersion()).toBe(pkg.version)
  })
})
