# 发布流程

发布 = 改版本号 → 写 CHANGELOG → 提交 → 打 tag → 推 tag。剩下的交给
`.github/workflows/release.yml`：先跑完整门禁，通过后发 npm 并创建 GitHub Release。

## 版本号策略

项目还在 `0.x`，对外接口随时可能变，但版本号仍然表达意图：

| 变更                                                   | 版本位 | 例子              |
| ------------------------------------------------------ | ------ | ----------------- |
| 破坏性变更（配置项改名、工具行为不兼容、会话映射变化） | minor  | `0.5.1` → `0.6.0` |
| 新功能、修复、文档与基础设施                           | patch  | `0.5.0` → `0.5.1` |

- 版本号**手工改**，不让 CI 或 bot 代改，避免版本被悄悄推进。
- npm 上已存在的版本不能重发。发布失败时只能换版本号重来（见[失败与回滚](#失败与回滚)）。
- tag 格式固定 `v<version>`，与 `package.json` 的 `version` 严格一致，例如 `v0.5.1`。

## 版本现状

- npm 最新：`0.3.4`（`@cmach_socket/opencode-qq-bot`）。
- 仓库当前：`0.5.1`。
- `0.4.0` / `0.5.0` 只改了版本号与 CHANGELOG，**从未发布到 npm，也没打 tag**；
  它们的内容由 `0.5.1` 一并发布。

## 发布前清单

1. 在 `main` 上，工作区干净（`git status` 无输出）。
2. `package.json` 的 `version` 改成目标版本。
3. `CHANGELOG.md` 增加 `## [x.y.z] - YYYY-MM-DD` 段，写清 Added / Changed / Fixed；
   这一段会原样成为 GitHub Release 正文。
4. 本地跑一遍：

   ```sh
   bun install --frozen-lockfile
   bun run ci
   bun run release:check --tag v0.5.1
   ```

   `release:check` 会校验：semver、CHANGELOG 段存在且非空、tag 与版本一致、
   `LICENSE` ↔ `package.json` 的 license、`NOTICE` 覆盖全部运行时依赖、工作区干净。
   工作区确实需要带着未提交改动检查时加 `--allow-dirty`（只用于本地排查，不要用它发布）。

5. 提交（`chore: release x.y.z`），推 `main`。
6. 打 tag 并推送：

   ```sh
   git tag -a v0.5.1 -m "v0.5.1"
   git push origin v0.5.1
   ```

7. 看 Actions：`Release` 工作流先跑 `verify`，通过后 `publish` 会
   `npm publish --provenance --access public`，再用 CHANGELOG 对应段创建 GitHub Release。

## 工作流做了什么

`.github/workflows/release.yml` 由 `v*` tag 触发，两段：

| job       | 内容                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `verify`  | 冻结锁文件安装 → `typecheck` → `lint` → `format:check` → `test` → `release-check --tag "$GITHUB_REF_NAME"`                      |
| `publish` | 用 `actions/setup-node` 装 npm → `npm publish --provenance --access public` → `gh release create --notes-file ... --verify-tag` |

- 用 npm 而不是 `bun publish`：`--provenance` 是 npm 的能力。
- `publish` 的权限只给到 `contents: write`（建 Release）与 `id-token: write`（provenance），
  其余 job 一律 `contents: read`。
- tag 与版本不一致、CHANGELOG 缺段、工作区有改动、许可证 / NOTICE 不一致，都会在
  `verify` 阶段失败，npm 上不会留下半成品。

## 首次配置（只需要做一次）

二选一：

**A. `NPM_TOKEN` secret（工作流当前写法）**

1. 在 npm 生成一个 Automation / Granular Access Token，权限限定为
   `@cmach_socket` 范围的 publish。
2. 仓库 Settings → Secrets and variables → Actions 新建 `NPM_TOKEN`。

**B. npm trusted publishing（OIDC，无需长期 token）**

1. 在 npm 包设置里添加 Trusted Publisher：GitHub Actions，
   仓库 `cmachsocket/opencode-qq-bot`，工作流文件名 `release.yml`。
2. 之后可以删掉 `NPM_TOKEN` 与 `NODE_AUTH_TOKEN`，`id-token: write` 已经具备。

`gh release create` 用的是 Actions 自带的 `GITHUB_TOKEN`，不需要额外配置。

## 失败与回滚

- **`verify` 失败**：npm 上没有发布任何东西。修完代码删掉 tag 重来：

  ```sh
  git tag -d v0.5.1
  git push origin :refs/tags/v0.5.1
  ```

- **npm 发布成功但 GitHub Release 失败**：补建 Release 即可，
  不要重推 tag（会重跑 `npm publish` 并因版本已存在而失败）。

  ```sh
  bun scripts/release-check.ts --tag v0.5.1 --notes > notes.md
  gh release create v0.5.1 --title v0.5.1 --notes-file notes.md --verify-tag
  ```

- **发布后才发现严重问题**：npm 允许在 **72 小时内** `npm unpublish <包名>@<版本>`；
  超过窗口就只能 `npm deprecate` 标注问题版本，并尽快发一个 patch。
  GitHub Release 保留，正文里写清楚受影响版本与替代版本。

- 已公开的版本不要为了「看起来干净」去改写历史或强推 tag；npm 与 GitHub 的审计记录比整洁更重要。

## 相关文件

- `scripts/release-check.ts`：发布门禁，可单独跑，也负责生成 Release 正文。
- `.github/workflows/ci.yml`：日常 CI，发布前应当已经是绿的。
- `docs/security-baseline.md`：发布前需要对照的安全基线。
- `SECURITY.md`：漏洞上报渠道。
