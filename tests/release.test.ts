import { describe, expect, it } from "vitest"
import {
  changelogSection,
  checkRelease,
  parseArgs,
  type ReleaseInput,
} from "../scripts/release-check"

const CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "- 还没发的东西",
  "",
  "## [0.5.1] - 2026-11-08",
  "",
  "### Added",
  "",
  "- 发布流水线",
  "",
  "## [0.5.0] - 2026-11-08",
  "",
  "- 旧版本",
  "",
].join("\n")

const LICENSE = [
  "本项目采用 知识共享 署名-非商业性使用-相同方式共享 4.0 国际 许可协议（CC BY-NC-SA 4.0）发布。",
  "This program is licensed under the Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International Public License.",
  "",
].join("\n")

const NOTICE = [
  "| 依赖      | 版权声明        |",
  "| --------- | --------------- |",
  "| alpha-dep | Copyright alpha |",
  "",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  "",
].join("\n")

function input(overrides: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    pkg: { version: "0.5.1", license: "CC-BY-NC-SA-4.0", dependencies: { "alpha-dep": "1.0.0" } },
    changelog: CHANGELOG,
    license: LICENSE,
    notice: NOTICE,
    ...overrides,
  }
}

describe("changelogSection", () => {
  it("取出对应版本的正文", () => {
    expect(changelogSection(CHANGELOG, "0.5.1")).toBe("### Added\n\n- 发布流水线")
  })

  it("没有该版本时返回 undefined", () => {
    expect(changelogSection(CHANGELOG, "9.9.9")).toBeUndefined()
  })

  it("版本号按字面匹配，不把 0.5.1 当成 0.5.10", () => {
    const text = "## [0.5.10]\n\n- 别的版本"
    expect(changelogSection(text, "0.5.1")).toBeUndefined()
  })
})

describe("checkRelease", () => {
  it("输入齐全时通过", () => {
    const report = checkRelease(input({ tag: "v0.5.1" }))
    expect(report.issues).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.notes).toBe("### Added\n\n- 发布流水线")
  })

  it("版本号不是 semver 时失败", () => {
    const report = checkRelease(input({ pkg: { ...input().pkg, version: "next" } }))
    expect(report.ok).toBe(false)
    expect(report.issues.join()).toContain("semver")
  })

  it("CHANGELOG 缺少该版本时失败", () => {
    const report = checkRelease(input({ pkg: { ...input().pkg, version: "0.6.0" } }))
    expect(report.ok).toBe(false)
    expect(report.issues.join()).toContain("缺少")
  })

  it("CHANGELOG 的版本段为空时失败", () => {
    const report = checkRelease(
      input({ changelog: "## [0.5.1] - 2026-11-08\n\n## [0.5.0] - 2026-11-08\n\n- 旧版本" }),
    )
    expect(report.ok).toBe(false)
    expect(report.issues.join()).toContain("是空的")
  })

  it("tag 与版本不一致时失败", () => {
    const report = checkRelease(input({ tag: "v0.5.0" }))
    expect(report.ok).toBe(false)
    expect(report.issues.join()).toContain("v0.5.1")
  })

  it("LICENSE 缺声明时失败", () => {
    const report = checkRelease(input({ license: "MIT" }))
    expect(report.ok).toBe(false)
    expect(report.issues.join()).toContain("LICENSE")
  })

  it("package.json 的 license 不对时失败", () => {
    const report = checkRelease(input({ pkg: { ...input().pkg, license: "MIT" } }))
    expect(report.ok).toBe(false)
    expect(report.issues.join()).toContain("CC-BY-NC-SA-4.0")
  })

  it("NOTICE 缺依赖时失败", () => {
    const report = checkRelease(
      input({
        pkg: { ...input().pkg, dependencies: { "alpha-dep": "1.0.0", "beta-dep": "2.0.0" } },
      }),
    )
    expect(report.ok).toBe(false)
    expect(report.issues.join()).toContain("beta-dep")
  })

  it("工作区不干净时失败", () => {
    const report = checkRelease(input({ dirty: true }))
    expect(report.ok).toBe(false)
    expect(report.issues.join()).toContain("未提交")
  })
})

describe("parseArgs", () => {
  it("默认全是关闭的", () => {
    expect(parseArgs([])).toEqual({ notes: false, json: false, allowDirty: false })
  })

  it("支持 --tag 空格与等号两种写法", () => {
    expect(parseArgs(["--tag", "v0.5.1"]).tag).toBe("v0.5.1")
    expect(parseArgs(["--tag=v0.5.1"]).tag).toBe("v0.5.1")
  })

  it("拒绝未知参数", () => {
    expect(() => parseArgs(["--nope"])).toThrow("未知参数")
  })
})
