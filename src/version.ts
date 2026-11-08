import { readFileSync } from "node:fs"

/** 读取 package.json 里的插件版本号；读取失败时返回 `unknown`。 */
export function pluginVersion(): string {
  try {
    const text = readFileSync(new URL("../package.json", import.meta.url), "utf8")
    const pkg = JSON.parse(text) as { version?: unknown }
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "unknown"
  } catch {
    return "unknown"
  }
}
