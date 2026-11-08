import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/** `package.json` 里发布用得上的字段。 */
export interface PackageJson {
  version: string
  license?: string
  dependencies?: Record<string, string>
}

/** 一次发布检查的输入。全部是纯数据，方便测试直接用 fixture。 */
export interface ReleaseInput {
  pkg: PackageJson
  changelog: string
  license: string
  notice: string
  /** `--tag` 传入的 tag，例如 `v0.5.1`。 */
  tag?: string
  /** 工作区是否有未提交改动；缺省按干净处理。 */
  dirty?: boolean
}

/** 检查结果。 */
export interface ReleaseReport {
  ok: boolean
  version: string
  notes: string
  issues: string[]
}

/** SPDX 标识 → LICENSE 文件里必须出现的文字。 */
const LICENSE_MARKERS: Record<string, string[]> = {
  "CC-BY-NC-SA-4.0": ["CC BY-NC-SA 4.0", "Attribution-NonCommercial-ShareAlike 4.0 International"],
}

/** 语义化版本号，允许 `-pre` / `+build` 后缀。 */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** 转义正则里的特殊字符。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * 取出 CHANGELOG 里 `## [version]` 这一节的正文。
 *
 * 没有这一节时返回 `undefined`；有但只有空白时返回空串。
 */
export function changelogSection(changelog: string, version: string): string | undefined {
  const lines = changelog.split(/\r?\n/)
  const heading = new RegExp(`^##\\s+\\[${escapeRegExp(version)}\\]`)
  const start = lines.findIndex((line) => heading.test(line))
  if (start === -1) return undefined
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break
    body.push(line)
  }
  return body.join("\n").trim()
}

/**
 * 跑完整套发布检查。
 *
 * 发现问题逐条记进 `issues`，`ok` 只在一条问题都没有时为真。
 */
export function checkRelease(input: ReleaseInput): ReleaseReport {
  const issues: string[] = []
  const { pkg, changelog, license, notice, tag, dirty } = input
  const version = pkg.version

  if (!SEMVER.test(version)) {
    issues.push(`package.json 的版本号不是合法 semver：${version}`)
  }

  const section = changelogSection(changelog, version)
  if (section === undefined) {
    issues.push(`CHANGELOG.md 缺少 \`## [${version}]\` 段`)
  } else if (section === "") {
    issues.push(`CHANGELOG.md 的 \`## [${version}]\` 段是空的`)
  }
  const duplicates = changelog
    .split(/\r?\n/)
    .filter((line) => new RegExp(`^##\\s+\\[${escapeRegExp(version)}\\]`).test(line)).length
  if (duplicates > 1) {
    issues.push(`CHANGELOG.md 里有 ${duplicates} 个 \`## [${version}]\` 段`)
  }

  if (tag !== undefined && tag !== `v${version}`) {
    issues.push(`tag ${tag} 与 package.json 版本不一致，应为 v${version}`)
  }

  const spdx = pkg.license
  if (!spdx) {
    issues.push("package.json 缺少 license 字段")
  } else if (spdx !== "CC-BY-NC-SA-4.0") {
    issues.push(`package.json 的 license 不是本项目使用的 CC-BY-NC-SA-4.0：${spdx}`)
  } else {
    for (const marker of LICENSE_MARKERS[spdx] ?? []) {
      if (!license.includes(marker)) {
        issues.push(`LICENSE 缺少许可声明：${marker}`)
      }
    }
  }

  const deps = Object.keys(pkg.dependencies ?? {})
  for (const dep of deps) {
    const row = new RegExp(`^\\|\\s*${escapeRegExp(dep)}\\s*\\|`, "m")
    if (!row.test(notice)) {
      issues.push(`NOTICE 的依赖表缺少 ${dep}`)
    }
  }
  if (!notice.includes("Permission is hereby granted, free of charge")) {
    issues.push("NOTICE 缺少 MIT 许可全文")
  }

  if (dirty) {
    issues.push("工作区有未提交改动，先提交或加 --allow-dirty 跳过")
  }

  return { ok: issues.length === 0, version, notes: section ?? "", issues }
}

/** 解析过的命令行参数。 */
export interface Args {
  tag?: string
  notes: boolean
  json: boolean
  allowDirty: boolean
}

/** 解析命令行参数；不认识的参数直接报错。 */
export function parseArgs(argv: string[]): Args {
  const args: Args = { notes: false, json: false, allowDirty: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ""
    const [flag, inline] = arg.split("=", 2)
    if (flag === "--notes") args.notes = true
    else if (flag === "--json") args.json = true
    else if (flag === "--allow-dirty") args.allowDirty = true
    else if (flag === "--tag") {
      const value = inline ?? argv[index + 1]
      if (!value) throw new Error("--tag 需要一个值，例如 --tag v0.5.1")
      args.tag = value
      if (inline === undefined) index += 1
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return args
}

/** 读仓库根目录下的文件。 */
function read(root: string, name: string): string {
  return readFileSync(join(root, name), "utf8")
}

/** CLI 入口：`bun scripts/release-check.ts [--tag vX.Y.Z] [--notes] [--json] [--allow-dirty]`。 */
function main(argv: string[]): number {
  const cwd = process.cwd()
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  const git = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" })
  const dirty = git.status !== 0 || (git.stdout ?? "").trim() !== ""

  const report = checkRelease({
    pkg: JSON.parse(read(cwd, "package.json")) as PackageJson,
    changelog: read(cwd, "CHANGELOG.md"),
    license: read(cwd, "LICENSE"),
    notice: read(cwd, "NOTICE"),
    ...(args.tag === undefined ? {} : { tag: args.tag }),
    ...(args.allowDirty ? {} : { dirty }),
  })

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else if (args.notes) {
    process.stdout.write(`${report.notes}\n`)
  } else if (report.ok) {
    process.stdout.write(`发布检查通过：${report.version}\n`)
  }
  if (!report.ok) {
    process.stderr.write(`发布检查未通过：${report.version}\n`)
    for (const issue of report.issues) process.stderr.write(`- ${issue}\n`)
  }
  return report.ok ? 0 : 1
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2))
}
