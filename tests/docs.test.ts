import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { ENV_VARS } from "../src/config"

const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8")
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
const known = new Set<string>(Object.values(ENV_VARS))

/** 取出 `.env.example` 里声明过的环境变量名。 */
function envExampleNames(): string[] {
  return [...envExample.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined)
}

/** 取出 README 配置表里声明过的环境变量名。 */
function readmeNames(): string[] {
  return [...readme.matchAll(/^\|\s*`[^`]+`\s*\|\s*`([A-Z][A-Z0-9_]+)`\s*\|/gm)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined)
}

describe("环境变量文档", () => {
  it("`.env.example` 只列出代码里真实存在的环境变量", () => {
    for (const name of envExampleNames()) {
      expect(known.has(name), `${name} 不在 config.ts 的 ENV_VARS 里`).toBe(true)
    }
  })

  it("`.env.example` 覆盖全部环境变量", () => {
    const documented = new Set(envExampleNames())
    for (const name of known) {
      expect(documented.has(name), `${name} 没有写进 .env.example`).toBe(true)
    }
  })

  it("README 配置表覆盖全部环境变量", () => {
    const documented = new Set(readmeNames())
    for (const name of known) {
      expect(documented.has(name), `${name} 没有写进 README 的配置表`).toBe(true)
    }
  })

  it("已移除的配置项不会残留在文档里", () => {
    for (const name of ["QQ_BUSY_TIMEOUT_MS"]) {
      expect(envExample).not.toContain(name)
      expect(readme).not.toContain(name)
    }
  })
})
