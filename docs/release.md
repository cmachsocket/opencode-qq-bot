# 发布流程

发布 = 改版本号 → 写 CHANGELOG → 提交 → 打 tag → 推 tag。剩下的交给
`.github/workflows/release.yml`：先跑完整门禁，通过后把包**暂存**到 npm 并创建 GitHub Release；
版本要维护者在 npm 侧用 2FA 批准（`npm stage approve`）之后才真正可安装。

## 版本号策略

项目还在 `0.x`，对外接口随时可能变，但版本号仍然表达意图：

| 变更                                                   | 版本位 | 例子              |
| ------------------------------------------------------ | ------ | ----------------- |
| 破坏性变更（配置项改名、工具行为不兼容、会话映射变化） | minor  | `0.5.1` → `0.6.0` |
| 新功能、修复、文档与基础设施                           | patch  | `0.5.0` → `0.5.1` |

- 版本号**手工改**，不让 CI 或 bot 代改，避免版本被悄悄推进。
- 已经批准上线的版本不能重发。发布失败时只能换版本号重来（见[失败与回滚](#失败与回滚)）；
  只暂存、未批准的版本可以用 `npm stage reject` 撤掉后重来。
- tag 格式固定 `v<version>`，与 `package.json` 的 `version` 严格一致，例如 `v0.5.1`。

## 版本现状

- npm 最新：`0.5.1`（`@cmach_socket/opencode-qq-bot`）。
- 仓库当前：`0.6.6`。
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
   bun run privacy:scan   # 需要本地有 trufflehog；CI 一定会跑
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
   `npm stage publish --provenance --access public`（只暂存，不直接上线），
   再用 CHANGELOG 对应段创建 GitHub Release。
8. 批准上线（需要 2FA）：

   ```sh
   npm stage list                          # 拿到暂存记录的 id
   npm stage view <id>                     # 看元数据
   npm stage download <id>                 # 可选：下载 tarball 检查内容
   npm stage approve <id>                  # 2FA 批准，版本此刻才可安装
   ```

   也可以直接在 npm 包页面批准。批准前 `npm install` 拿不到新版本；
   不打算要这一版就 `npm stage reject <id>` 撤掉暂存记录。

## 工作流做了什么

`.github/workflows/release.yml` 由 `v*` tag 触发，两段：

| job       | 内容                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| `verify`  | 冻结锁文件安装 → `typecheck` → `lint` → `format:check` → `test` → `release-check --tag "$GITHUB_REF_NAME"`            |
| `publish` | 用 `actions/setup-node` 装 npm → `npm stage publish --provenance` → `gh release create --notes-file ... --verify-tag` |

- 用 npm 而不是 `bun publish`：`--provenance` 与 staged publishing 都是 npm 的能力。
- `publish` 的权限只给到 `contents: write`（建 Release）与 `id-token: write`（OIDC / provenance），
  其余 job 一律 `contents: read`。
- tag 与版本不一致、CHANGELOG 缺段、工作区有改动、许可证 / NOTICE 不一致，都会在
  `verify` 阶段失败，npm 上不会留下半成品。
- **发布是 stage-only 的**：CI 只能 `npm stage publish`，`npm publish` 与 dist-tag 操作
  不在信任关系里，所以自动化流程拿不到直接上线权限。版本进入 registry 的唯一路径是
  维护者 2FA 批准。

## 首次配置（只需要做一次）

工作流默认走 **npm trusted publishing（OIDC）**，不需要长期 token：

1. 在 npm 包设置里添加 Trusted Publisher：GitHub Actions，
   仓库 `cmachsocket/opencode-qq-bot`，工作流文件名 `release.yml`，Environment 留空，
   Allowed actions 只勾 `npm stage publish`（**不要**勾 `npm publish`）。
2. 工作流已经带 `id-token: write`，并把 npm 固定到 `11.15.0`（staged publishing 的最低版本；
   Node 22 自带的 10.x 不支持）。

npm 在 2026-09-03 之后新建的 trusted publisher 默认就是 stage-only；
更早创建的配置默认只允许 `npm publish`，直接跑 `npm stage publish` 会报
`OIDC permission denied for this action`，需要回 npm 设置里补勾 `npm stage publish`。

如果改用长期 token，需要把 workflow 的发布步骤改回去：加 `registry-url`，
并给 `npm publish` 传 `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`。

`gh release create` 用的是 Actions 自带的 `GITHUB_TOKEN`，不需要额外配置。

## 失败与回滚

- **`verify` 失败**：npm 上没有发布任何东西。修完代码删掉 tag 重来：

  ```sh
  git tag -d v0.5.1
  git push origin :refs/tags/v0.5.1
  ```

- **暂存成功但 GitHub Release 失败**：补建 Release 即可，
  不要重推 tag（会重复执行 `npm stage publish`，同版本可能被拒）。

  ```sh
  bun scripts/release-check.ts --tag v0.5.1 --notes > notes.md
  gh release create v0.5.1 --title v0.5.1 --notes-file notes.md --verify-tag
  ```

- **暂存了但不想要这一版**：`npm stage reject <id>` 撤掉暂存记录。暂存从不影响
  registry，`npm install` 不会看到它，所以撤掉后可以修完重新走一遍发布。
  批准之前版本号没有被占用。

- **发布后才发现严重问题**：npm 允许在 **72 小时内** `npm unpublish <包名>@<版本>`；
  超过窗口就只能 `npm deprecate` 标注问题版本，并尽快发一个 patch。
  GitHub Release 保留，正文里写清楚受影响版本与替代版本。

- 已公开的版本不要为了「看起来干净」去改写历史或强推 tag；npm 与 GitHub 的审计记录比整洁更重要。

## 相关文件

- `scripts/release-check.ts`：发布门禁，可单独跑，也负责生成 Release 正文。
- `.github/workflows/ci.yml`：日常 CI，发布前应当已经是绿的。
- `docs/security-baseline.md`：发布前需要对照的安全基线。
- `SECURITY.md`：漏洞上报渠道。
