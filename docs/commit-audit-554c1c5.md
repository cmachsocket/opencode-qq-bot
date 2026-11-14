# 提交审计：554c1c5..HEAD

> 状态：审计完成。范围内 22 个提交（面板新页面 + 会话绑定持久化 + 收藏表情工具 + 3 次发布 + CI/文档改动），
> 发现 4 个高危、9 个中危、12 个低危问题。高危 1、3、4 与中危 13 用真实模块实测复现过，
> 其余各条给出了可复现的代码路径与位置。
> 修复状态：除中危 8（面板默认开启，已定为设计决定、保持现状）外，其余全部已修复，
> 各条末尾记录了做法。

审计范围：`554c1c5562848fc76dc5faf5486d5237145f11f9` 之后的全部提交，直到 `0af32e6`。

| 提交      | 内容                                             |
| --------- | ------------------------------------------------ |
| `d52ee1d` | 记录上一轮审计的修复并订正面板文档               |
| `8a45137` | CI 与发布流程里构建面板前端                      |
| `0c1b8bd` | 发布 0.9.0                                       |
| `5926f21` | CI 的凭证检测排除测试夹具                        |
| `05f8d51` | 按 `config.json` 的新布局刷新配置示例            |
| `d02b2a3` | CI 在发布前扫描凭证                              |
| `9616811` | 面板默认开启，令牌改为集中生成                   |
| `82bc356` | 发布 0.9.1                                       |
| `83c086f` | 新增动画表情收藏工具                             |
| `715f96e` | 精简 README                                      |
| `2fade6e` | 订正主动说话白名单的描述                         |
| `760daf8` | 发布 0.9.2                                       |
| `06b3623` | 上游会话消失时重建 keepalive 会话                |
| `66b33fa` | 配置校验挪到服务端，前端在 CSP 下也能保存        |
| `d6b048d` | 会话覆盖改用全局配置项的名字                     |
| `2a8fed1` | 面板新增「会话覆盖」与「工具档案」两页           |
| `257b18b` | 为面板前端加 jsdom 测试工程                      |
| `7d5b817` | 去掉 `web/tsconfig.json` 里废弃的 `baseUrl`      |
| `131ab5e` | 在 CHANGELOG 里记录面板新页面                    |
| `27a46fc` | 跨重启保留会话绑定（版本化绑定 + 合并写 + 墓碑） |
| `7336fa8` | 新增 `/stop` 与 `/compact` 管理命令              |
| `0af32e6` | 日记标注聊天标识，总结会话注入人格               |

变更规模：85 个文件，+6205/-992。四块主线：

- **面板扩展**：`src/panel/documents.ts`（451 行，新增）+ `src/panel/api.ts` 新增 4 个接口 +
  `web/src/routes/{ChatOverridesPage,ToolProfilesPage}.svelte`（1010 行，新增）。
- **会话绑定持久化**：`src/session/manager.ts`（+527）、`src/state-lock.ts`（新增）、
  `src/fs/atomic.ts`（新增）、`src/known-secrets.ts`（新增）。
- **收藏表情**：`src/emoji/collection.ts`（289 行，新增）+ `qq_collect_sticker` 工具。
- **配置变更**：`panel.enabled` 与 `reuseSession` 的默认值翻转，`ChatOverride` 的字段名改成与全局配置同名。

验证基线（审计时 HEAD `0af32e6`，工作区干净）：

- `bun run typecheck`（`tsc --noEmit` + `tsc -p tests/web/tsconfig.json`）通过，无输出。
- `bun run lint`（`eslint`）通过，无告警。
- `bun run test`（`vitest run`）52 个文件 / 960 个用例全绿（5.80s）。

---

## 修复状态

| 编号    | 问题                                     | 状态     | 做法                                   |
| ------- | ---------------------------------------- | -------- | -------------------------------------- |
| 高危 1  | 原型属性名当配置档 → 工具策略崩溃        | 已修复   | 解析器改用无原型映射 + 保留名拒绝      |
| 高危 2  | 面板新增记录会清空同名已有记录           | 已修复   | 新建与编辑分开；服务端拒绝清空式新建   |
| 高危 3  | 会话覆盖可把任意本机文件注入系统提示词   | 已修复   | 允许目录 + 内容闸门（大小/凭证/掩码）  |
| 高危 4  | 两个文档读—改—写无锁，并发保存静默丢改动 | 已修复   | 两次保存共用一把文件锁                 |
| 中危 5  | 写锁拿不到时只打日志不重试，状态直接丢失 | 已修复   | 退避重试，仍失败才记错误               |
| 中危 6  | 共享绑定表只增不减                       | 已修复   | 清理失效条目 + 容量上限                |
| 中危 7  | `panel.token` 永远删不掉                 | 已修复   | 新增 `panel.tokenRevoked` 吊销开关     |
| 中危 8  | 面板默认开启                             | 保持现状 | 决策保持默认开启，只补文档与 CHANGELOG |
| 中危 9  | 告警文本当 `{#each}` 的 key → 整页白屏   | 已修复   | 告警去重 + 页面改用下标作 key          |
| 中危 10 | 新页面没有「跟随默认」选项，选了回不去   | 已修复   | 两个新页面复用 `EMPTY_CHOICE` 哨兵     |
| 中危 11 | 客户端与服务端的唤醒前缀校验不一致       | 已修复   | 服务端校验并拒绝，页面前置提示         |
| 中危 12 | 被引用的配置档在界面上永远删不掉         | 已修复   | 删除时自动解除引用                     |
| 中危 13 | 保存时抹掉文件里的其他顶层键             | 已修复   | 写回时保留原文件的其它顶层键           |
| 低危    | 见下文「低危 / 提示」                    | 已修复   | 12 条逐条处理，见各条末尾              |

---

## 高危

### 1. 面板「工具档案」能写入原型属性名，把机器人打成不可用

`src/panel/documents.ts:67` 的档名约束放行了 `__proto__`：

```ts
const PROFILE_NAME = /^[^\s\p{C}]{1,64}$/u
```

`__proto__`、`constructor`、`toString` 都符合这个正则。`documents.ts:407` 与 `:416` 的引用检查
用的是 `!effective.profiles[name]`，而 `effective.profiles` 是普通对象，`profiles["__proto__"]`
取到的是 `Object.prototype`——**永远为真**，于是「指向不存在的配置档」这道检查形同虚设。

运行时 `src/tools/policy.ts:149` 用 `{}` 建 `profiles`，`profileNameFor()`（`:201`）在
`file.profiles[named]` 上命中 `Object.prototype`，`allowedTools()`（`:208`）执行
`profile.deny.some(...)` 时 `deny` 是 `undefined` → 抛异常。

实测（`bun`，真实模块）：

```
saveToolProfiles(runtime, { chats: { "group:1": "__proto__" } })
  → problems: []
  → 落盘 {"defaultProfile":"chat","profiles":{},"chats":{"group:1":"__proto__"}}
  → policy.allow(...) 崩溃：undefined is not an object (evaluating 'profile.deny.some')

saveToolProfiles(runtime, { defaultProfile: "__proto__" })
  → problems: []
  → 每个非管理聊天都崩溃
```

影响面：`src/index.ts:716` 的 `ctx.session.hook("context", …)`——该聊天**完全无法处理消息**；
`src/tools/policy-guard.ts:41`（每次工具调用）、`src/commands.ts:250,263`（`/tools`）。
`defaultProfile` 被污染时是所有聊天一起挂。

建议：

1. `PROFILE_NAME` 显式排除 `__proto__` / `constructor` / `prototype`（或所有 `Object.prototype` 上的属性名）；
2. `parseToolPolicy()` 与 `parseChatOverrides()` 里的映射改用 `Object.create(null)`，
   `Object.hasOwn()` 做存在性判断——这是根因，`parseToolPolicy` 的原型污染面比面板更早存在；
3. 面板的引用检查与运行时解析共用同一套判断，不要各写一份。

位置：`src/panel/documents.ts:67,407,416`、`src/tools/policy.ts:149,201,208`

**已修复**：新增 `src/safe-object.ts`（`safeMap()` / `isSafeKey()` / `hasKey()` / `copyToSafeMap()`）。
`parseToolPolicy()` 与 `parseChatOverrides()` 的映射改用 `Object.create(null)`，
存在性判断统一走 `Object.hasOwn()`；`PROFILE_NAME` 之外再挡一层保留名
（`__proto__` / `constructor` / `prototype`），面板的引用检查与运行时解析共用同一套判断。
`allowedTools()` 对缺失的 `allow` / `deny` 兜底成空数组，档缺失时 `ToolPolicy.allow()` 返回空集合并告警，
不再抛 `profile.deny.some`。测试见 `tests/policy.test.ts` 与 `tests/panel-documents.test.ts`。

### 2. 面板新增记录会把同名已有记录整条清空

`web/src/routes/ChatOverridesPage.svelte:176-184` 的 `save()` 提交**全部 8 个字段**，
空值经 `patchValue()`（`:147-165`）转成 `null`；`src/panel/documents.ts:251-262` 把 `null`
解释成「删除这个字段」：

```ts
if (value === null) {
  delete current[name]
  continue
}
```

「新建聊天」的流程里所有字段都留空，于是表单提交出去的是 8 个 `null`。
如果这个聊天键**已经存在**（界面上新建时没有做存在性检查，服务端也没有），
一次保存就把它清成 `{}`——没有任何报错，接口返回 200。

同类问题在「工具档案」页：`ToolProfilesPage.svelte:113-143` 的 `saveProfile()` 总是提交
`allow` / `deny`（空数组也照交），`documents.ts:354-364` 于是把已有档案的列表覆盖成 `[]`。

这不是新页面的边角——这两个页是本轮新增的主功能，`docs/panel.md` 还把它们当成推荐入口。

建议：

1. 前端区分「新建」与「编辑」：新建只提交用户真正填了的字段；
2. 服务端对「键不存在 + 该条所有字段都是删除意图」明确拒绝，而不是当成清空；
3. 面板保存前先比对文件里的原值，被整体清空时要求二次确认。

位置：`web/src/routes/ChatOverridesPage.svelte:147-184`、
`web/src/routes/ToolProfilesPage.svelte:113-143`、`src/panel/documents.ts:251-262,354-364`

**已修复**：前端区分「新增」与「编辑」——新增时只提交用户真正填了的字段，
新建一个已存在的键直接在前端拦下并提示去点「编辑」。
服务端对「键不存在 + 这一条所有字段都是删除意图」明确拒绝（400），
对「这一条没有任何可保存的字段」只告警并跳过，文件不动。
两个页面都补了回归测试。

### 3. 「会话覆盖」能把任意本机文件注入系统提示词

面板把 `soulPath` / `soulName` 原样写进 `chat-overrides.json`
（`src/panel/documents.ts:261`，字段白名单 `CHAT_OVERRIDE_FIELDS` 里有这两项），
而 `src/session/soul.ts:79-86` 的 `resolveSoulPath()` 对三种输入都不设防：

```ts
const target = isAbsolute(explicit) ? explicit : resolve(options.home, explicit)
```

- 绝对路径 → 原样返回（`/etc/passwd` 就是 `/etc/passwd`）；
- 相对路径 → `resolve(home, explicit)`，`../../../../etc/passwd` 一样逃得出去；
- `soulName` → `join(soulsDirectory(home), name)`，`../../../etc/passwd` 同样逃得出去。

实测（`bun`，真实模块）：

```
saveChatOverrides(runtime, { chats: { "group:1": { soulPath: "/etc/passwd" } } })
  → problems: []
  → 落盘 {"chats":{"group:1":{"soulPath":"/etc/passwd"}}}
  → resolveSoulPath 返回 /etc/passwd
  → src/index.ts:663 把文件内容 push 进 event.system
```

也就是文件内容会随提示词一起发给模型服务商——`~/.ssh/id_rsa`、`~/.aws/credentials` 都在射程内。
`SoulStore.#watch()` 还会对 `dirname(path)` 建一个 FSWatcher，任意目录都会被监听。

以前只能手改 JSON 才做得到，现在一次面板请求就能做到。

**风险要摆正。** 面板是管理员入口，管理员本来就能通过面板改配置、换模型、发文件，
「管理员能让机器人读本机某个文件」对他自己并不构成提权。所以问题不在「路径能不能越界」，
而在**这个文件的内容没有闸门就直接进了提示词**：

- `src/index.ts:663` 每轮都把 `soul.prompt`（= 文件正文 + QQ 工具守则）推进 `event.system`，
  也就是说文件内容会**一轮一次**地发给模型服务商；
- 内容里如果混进了 `~/.ssh/id_rsa`、`~/.aws/credentials`，模型很可能把它复述到**群里**——
  一次手滑的路径配置就变成一次密钥泄露，而且泄露路径是「群聊」，不是「管理员自己看得到」；
- `SoulStore.#watch()` 会对 `dirname(path)` 建 FSWatcher，越界目录也会被持续监听；
- `readFile(path, "utf-8")` 没有大小与类型限制，把视频或数据库当人格文件会把整份读进内存，
  而且每轮读一次；
- 路径解析不做规范化（`resolve` 之后不 `realpath`），符号链接可以绕过任何基于字符串的前缀判断。

因此**不建议**用「禁止绝对路径 / 禁止越出工作目录」来修——那会砍掉「把人格文件放在
`~/my-souls/` 或共享目录里」这个正当用法，是拿功能换安全，而且挡不住真正的泄露路径。

建议（保持功能，只补边界）：

1. **规范化之后再判定，而不是禁止绝对路径**：路径先 `resolve` 再 `realpath`，
   跟「允许根」比较；允许根做成配置项（新增 `soul.allowedPaths`，默认 = 工作目录 + `souls/` 目录）。
   用户要指向外部目录，自己加一条即可——边界由用户声明一次，功能不丢。
   符号链接按**目标**判定，`souls/link → /etc/passwd` 这种绕过自然失效。
2. **给内容加闸门（真正堵住泄露的那一步）**：注入提示词之前，
   - 只读常规文件，大小上限（例如 64KB），超限拒绝并告警；
   - 走已有的 `src/sensitive.ts` `SensitiveChecker.check()`（私钥块、已知凭证、
     指向凭证文件的路径都有检测器）→ 命中就**拒绝加载**并告警，不把内容送进提示词；
   - 再走 `maskKnownSecrets()`，把面板令牌、NapCat 令牌、URL 查询串里的凭证替换成 `[REDACTED]`；
   - 剔除非文本控制字符。
     这样「人格文件里刚好有私钥」不再等于「私钥被发出去」。
3. **面板上要看得见**：越出允许根的条目在列表里标出来（工作目录之外），保存时提示一次。
   是提示，不是拒绝——让人知道自己配了什么。
4. **只对允许根内的路径建 FSWatcher**；外部路径改成启动时读一次（或按 mtime 轮询），
   不再对任意目录挂监听。
5. **按 mtime 缓存人格正文**，顺带解决「每轮读一次盘」的开销。
6. 校验放在 `parseChatOverrides()`（运行时解析器）里，而不是只在面板里——手改 JSON 同样要拦。

位置：`src/panel/documents.ts:261`、`src/session/soul.ts:79-86`、`src/overrides.ts:192-205`、
`src/index.ts:663`

**已修复**：新增 `src/session/soul-guard.ts`，按审计给的思路落地：

1. 路径先 `resolve` 再 `realpath`，跟允许根比较，允许根 = 工作目录 + `souls.allowedPaths`（新增配置项）
   - 工作目录下的 `souls/`；符号链接按目标判定；
2. 内容闸门：只读常规文件、大小上限 64KB，命中私钥等凭证形状就整份拒绝加载并告警，
   机器人自己的已知凭证明文替换成 `[REDACTED]`，控制字符剔除；
3. 越界的条目在告警里说清楚，面板保存时保留用户的原意（文件里写着，运行时忽略）；
4. 允许根之外的文件不建 FSWatcher；文件还不存在时只在允许根内留监听；
5. 按 mtime 缓存正文，缓存条数有上限；
6. 校验放在 `parseChatOverrides()` 里，手改 JSON 同样拦得住。

测试见 `tests/soul.test.ts`（越界拒绝、私钥拒绝、已知密钥掩码、超大文件拒绝）。

### 4. 两个文档的「读—改—写」没有互斥，并发保存静默丢改动

`src/panel/documents.ts:232-272`（会话覆盖）与 `:322-432`（工具档案）都是同一个套路：
读文件 → 合并 → 写文件，中间没有任何锁。仓库里已经为此准备了 `src/state-lock.ts`
（`@bybrave/proper-lockfile2`），但**只有会话管理器在用**。

实测（两个并发 `PUT` 走真实的 Hono app）：

```
PUT /api/chat-overrides {"chats":{"group:1":{"wake":"all"}}}
PUT /api/chat-overrides {"chats":{"group:2":{"wake":"none"}}}     ← 同时发
→ 状态码 [200, 200]
→ 磁盘 {"chats":{"group:2":{"wake":"none"}}}      ← group:1 静默消失
```

`/api/tool-profiles` 同样。两个浏览器标签页、UI 与 `curl` 并行、或用户在面板外用编辑器改文件都会撞上。
`write-file-atomic` 保证单次写不撕裂，但保证不了「读—改—写」的原子性。

建议：面板的两次保存复用 `src/state-lock.ts` 的同一把锁（锁文件在 `home.lockPath`），
或者在 `PanelServer` 内加一个进程内互斥 + 文件锁的两层保护。

位置：`src/panel/documents.ts:232-272,322-432`、`src/state-lock.ts`

**已修复**：面板的两次保存都走 `withDocumentLock()`：锁文件放在文档旁边
（`.<文件名>.lock`），用 `acquireStateLock()` 拿锁，「读—改—写」整段都在锁里，
拿不到锁时返回 409 语义的提示而不是静默覆盖。
回归测试见 `tests/panel-documents.test.ts` 的「并发保存不会互相覆盖」。

---

## 中危

### 5. 写锁拿不到时只打日志不重试，状态直接丢失

`src/session/manager.ts:627-656` 的 `persist()`：

```ts
const lock = await acquireStateLock(this.home.lockPath, { … })
if (!lock) {
  this.logger.warn("共享状态写锁被占用，本轮状态稍后重试保存")
  return // ← 直接返回，没有重试
}
```

日志说「稍后重试保存」，但**没有任何重试**。这一轮的状态只有等下一次无关的 `scheduleSave()`
才会再落盘；如果那之前进程退出，绑定就丢了——而 `27a46fc` 整件事就是为了让绑定跨重启存活。

建议：拿不到锁时排一次延迟重试（带退避与次数上限），或者把待写状态留在内存里等下一次保存；
日志文案要与实际行为一致。

位置：`src/session/manager.ts:627-656`

**已修复**：`persist()` 拿不到写锁时排一次延迟重试（指数退避，最多 5 次，最长 5 秒），
日志文案改成「将稍后重试保存」；重试次数用尽才记一条错误日志，日志与行为一致。

### 6. 共享绑定表只增不减

`src/session/manager.ts:746-801` 的 `writeBindings()` 合并存量绑定时**永远保留存量条目**，
只有墓碑（tombstone）能删条目。于是被移出白名单的聊天、被删掉的聊天留下的绑定永远留在表里，
共享状态文件单调增长。

建议：合并时把「本地已无此目标且不在白名单内」的条目一并清理，或给表加容量上限与淘汰策略。

位置：`src/session/manager.ts:715-801`

### 7. `panel.token` 永远删不掉

`src/config/live.ts:85-99` 的 `ensureSecrets()`：只要 `panel.enabled` 为真且 `panel.token` 为空，
就生成一个新的 32 字节令牌写回配置。面板里删除令牌 → 立刻被重新生成 → 用户以为已经吊销，
实际令牌换了个值但没被撤销，旧会话也没有被作废。

建议：提供明确的「吊销令牌」语义（例如写一个 `panel.tokenRevokedAt` 标记，或允许置空并暂停面板），
让「删掉」与「自动补一个」区分开。

位置：`src/config/live.ts:85-99`、`src/config/fields.ts`（`panel.token`）

**已修复**：新增 `panel.tokenRevoked` 布尔字段（`src/config/fields.ts`）。面板里的「吊销」会清空 `token`、
置 `tokenRevoked: true` 并停止面板（`src/panel/server.ts` 的 `apply()` 调用 `auth.clear()` + `closeServer()`）；
`ensureSecrets()` 只对未吊销的面板补发令牌，吊销状态下不再重新生成。写入非空 `panel.token` 会把
`tokenRevoked` 复位为 `false`，所以「轮换令牌」仍是直接换值；仅清空令牌不算吊销。
`docs/panel.md` 补了吊销与轮换说明，测试见 `tests/panel-server.test.ts`。

### 8. 面板默认从关闭改成开启（设计决定：保持默认开启）

`src/config/fields.ts:741-748` 把 `panel.enabled` 的默认值从 `false` 翻成 `true`。
升级到 0.9.1 的用户会在**没有主动要求**的情况下：

- 自己的 `config.json` 里被写入一个明文令牌（文件 0600、目录 0700）；
- 机器上多出一个监听 `127.0.0.1:7391` 的 HTTP 服务；
- 令牌生成走了 `ensureSecrets()`，与 `applyPatch()` 的递归调用要靠「嵌套调用能看见令牌」来收敛。

**结论：保持默认开启，不改默认值。** 面板是本机管理入口，默认开着省掉「先开面板才能看面板」这一步；
默认监听 `127.0.0.1`、令牌自动生成、文件 0600 / 目录 0700、接口全部走令牌鉴权，
这些约束下默认开启的风险面是可控的。令牌生成逻辑本身也复核过：递归会收敛，
`panel.token` 是注册表里的 secret 字段（接口只回 `hasValue`），日志里也进了 `knownSecrets`。

需要补的只有文档，不是行为：

1. CHANGELOG 里点名这次默认值变更，写清「首次启动会在 `config.json` 写入 `panel.token`，
   并在 `127.0.0.1:7391` 起一个本机面板」；
2. `docs/panel.md` 与 README 写清**怎么关掉**（`panel.enabled: false`），
   以及令牌在哪看、怎么轮换；
3. `docs/panel.md` 里补一句「面板默认只监听回环地址，不要把 `panel.host` 改成 `0.0.0.0` 暴露到网络上」。

位置：`src/config/fields.ts:741-748`、`src/config/live.ts:85-99`

**已修复（仅补文档）**：按要求保持默认开启，未改默认值。`CHANGELOG.md` 的 `[Unreleased]` 点名了默认值变更、
首次启动会写入 `panel.token` 并监听 `127.0.0.1:7391`，同时给出关闭（`panel.enabled: false`）、轮换与吊销的方法；
`docs/panel.md`、`docs/configuration.md` 与 `README.md` 已同步说明，并明确提示不要把 `panel.host` 改成 `0.0.0.0`。

### 9. 告警文本当 `{#each}` 的 key，重复告警直接把页面打崩

`web/src/routes/ChatOverridesPage.svelte:276` 与 `web/src/routes/ToolProfilesPage.svelte:300`：

```svelte
{#each warnings as warning (warning)}
```

`src/panel/documents.ts:191-203` 的 `readToolProfiles()` **没有对 `warnings` 去重**
（只对 `masked` 去重了，保存路径 `:446` 才去重）。而 `parseToolPolicy()` → `readNames()`
（`src/tools/policy.ts:105-122`）对数组里的每一个非法项各告警一次，
`{"allow":[1,1]}` 就会产生两条一模一样的告警。

Svelte 的 keyed each 遇到重复 key 会抛未捕获的 `each_key_duplicate` → 整页白屏，
用户连「这个错是什么」都看不到。

建议：告警列表去重，或 key 改用索引；读取路径与保存路径统一走同一个去重函数。

位置：`web/src/routes/ChatOverridesPage.svelte:276`、`web/src/routes/ToolProfilesPage.svelte:300`、
`src/panel/documents.ts:191-203,446`

**已修复**：`readChatOverrides()` 与 `readToolProfiles()` 的 `warnings` 统一去重（保存路径同样），
两个页面的 `{#each}` 改用下标作 key，重复告警不会再触发 `each_key_duplicate`。

### 10. 新页面没有「跟随默认」选项，一旦选中就回不去

`ChatOverridesPage.svelte` 的唤醒模式下拉只有 `all / mention / prefix / none`，
`proactive.enabled` 只有 true / false。bits-ui 的 `Select.Root type="single"` 默认
`allowDeselect` 为 `false`，选中之后**清不掉**。

`web/src/routes/ConfigPage.svelte:235,314-322` 已经解决了这个问题：
用 `EMPTY_CHOICE = "__empty__"` 哨兵项表示「跟随默认」。两个新页面没有复用这个做法。

「工具档案」页的默认档下拉同样问题——服务端其实支持 `defaultProfile: null`（回到内置默认），
界面却没有入口。

建议：两个新页复用 `ConfigPage.svelte` 的 `EMPTY_CHOICE` 哨兵。

位置：`web/src/routes/ChatOverridesPage.svelte`、`web/src/routes/ToolProfilesPage.svelte`、
`web/src/routes/ConfigPage.svelte:235,314-322`

**已修复**：两个新页面复用 `ConfigPage.svelte` 的 `EMPTY_CHOICE = "__empty__"` 哨兵：
唤醒模式、`proactive.enabled`、工具档案默认档都能选回「跟随默认」（`defaultProfile: null`），
提交时把哨兵转成 `null`。

### 11. 客户端与服务端对「唤醒前缀」的校验不一致

界面允许选「前缀唤醒」但前缀列表留空。空列表在前端被转成 `null`（删字段），
服务端 `src/overrides.ts:206-210` 看到 `wake === "prefix"` 却没有前缀，
就把 `wake` **整个删掉**（回落到「被 @ 才必回」）并只告警一句。

结果：用户看到「已保存」，但唤醒方式已经被悄悄改掉了。

建议：把这条例外挪到面板的服务端校验里（`saveChatOverrides`），前端也据此禁用保存；
或者至少让保存结果明确回报「wake 已被重置」。

位置：`src/overrides.ts:206-210`、`web/src/routes/ChatOverridesPage.svelte`

**已修复**：`saveChatOverrides()` 在服务端校验「`wake: "prefix"` 但没有前缀」并返回 400，
不再静默删掉 `wake`；页面按同一规则前置提示并禁用保存。

### 12. 被引用的配置档在界面上永远删不掉

`web/src/routes/ToolProfilesPage.svelte:146-161` 的 `removeProfile()` 只发
`{ profiles: { [name]: null } }`；服务端 `src/panel/documents.ts:407-424` 校验的是**合并之后**的文档，
只要 `defaultProfile` 或某个 `chats.*` 还在引用它，就整单拒绝：

```
配置档 custom 已被删除，但 chats.group:100 还在引用它
```

删除按钮只对内置档禁用（`disabled={busy || isBuiltin(name)}`），用户点得动、删不掉。
API 其实支持组合删除（`profiles:{custom:null}, chats:{"group:100":null}`，`tests/panel-documents.test.ts:313`
有覆盖），页面从不发这种请求。

建议：删除时自动解除引用（并把结果写进提示文案），或把「仍在被引用」做成禁用态而不是事后报错。

位置：`web/src/routes/ToolProfilesPage.svelte:146-161`、`src/panel/documents.ts:407-424`

**已修复**：`removeProfile()` 删除配置档时一并提交所有引用它的 `chats.*: null`（以及 `defaultProfile: null`），
服务端按合并后的文档校验通过，提示文案会列出被解除的引用。

### 13. 保存时抹掉文件里的其他顶层键

`src/panel/documents.ts:271` 写回 `const next = { chats: base }`，`:427-431` 写回
`{ defaultProfile, profiles, chats }`。文件里其它顶层键（`version`、`comment` 之类）
在下一次面板保存时就被抹掉了。

实测：`tool-profiles.json` = `{"version":2,"comment":"keep me",…}` → 保存一次后变成
`{"defaultProfile":"chat","profiles":{…},"chats":{}}`。

建议：写回时保留原文件的其它顶层键（读进来、合并、整体写回）。

位置：`src/panel/documents.ts:271,427-431`

**已修复**：两处保存都先读入原文档，只替换自己管理的顶层键（`chats`；`defaultProfile` + `profiles` + `chats`），
其余键（`version`、`comment` 等）原样写回。回归测试见 `tests/panel-documents.test.ts` 的「保留顶层键」用例。

---

## 低危 / 提示

1. **`maskDocument` 会把 `__proto__` 键悄悄丢掉**（`src/panel/documents.ts:114-124`）。
   `next[key] = masked.value` 命中 `__proto__` 的 setter，键不再是自有属性，`JSON.stringify` 也会丢掉它。
   结果是**面板显示的文件与磁盘上的文件不一致**，而且下一次保存会真的把这个键删掉。
   建议用 `Object.defineProperty` 或 `Object.create(null)` 重建对象。
2. **短于 12 个字符的密钥不会被掩码**（`src/sensitive.ts:339`）。`knownSecrets()` 照收
   `napcat.token` / `panel.token`，掩码器却按 `MIN_SECRET_LENGTH = 12` 跳过。
   用户自设的短令牌（`src/config/live.ts:89` 只对 < 16 告警）会被面板原样回显。
   建议：掩码只看「是不是已知密钥」，不看长度。
3. **原子写会跟随符号链接**（`src/fs/atomic.ts:24-28`）。`write-file-atomic@8` 内部先
   `fs.realpath(filename)`，再把临时文件 rename 到**解析后的目标**上。
   `config.json` / `chat-overrides.json` / `tool-profiles.json` 若是符号链接，
   写出去的是链接目标的内容，链接本身被替换。`backupFile()` 同样。
   建议：写之前判断目标是否为符号链接，是则拒绝或明确按「写链接本身」处理。
4. **rename 之后没有 fsync 目录**（`src/fs/atomic.ts`）。文件本身 fsync 了，目录没有，
   断电时 rename 可能丢失。模块注释里「中途失败不会留下半截文件」成立，
   但「崩溃安全」的表述要收一收。
5. **两个新 PUT 接口不校验 `Content-Type`**（`src/panel/api.ts:207,225`；`PUT /api/config` 在 `:166-170` 有）。
   `readJson()`（`:327-333`）不管声明类型都按 JSON 解析。
   另外 hono 的 `csrf` 中间件只覆盖表单类 content type，`application/json` 下只剩自定义的 Origin 检查，
   而 Origin 检查**允许完全不带 Origin 头**的请求（`api.ts:100-115`）。
   会话 Cookie 是 `HttpOnly + SameSite=Strict`，实际暴露有限，但纵深防御比 `/api/config` 弱。
   建议：两个新端点与 `/api/config` 保持一致。
6. **两个文档对未知字段的处理不一致**：会话覆盖 → 告警后静默丢弃（`src/panel/documents.ts:252-255`），
   工具档案 → 400（`:355-359`）。`docs/panel.md:334-336` 把两者写在一起讲，行为却不同。
7. **无界增长的三处**：① `turnClearedAt` 从不清理（`src/session/manager.ts`）；
   ② `SoulLibrary` 按绝对路径缓存 `SoulStore`，路径可任意指定则缓存无界（`src/session/soul.ts:226-235`）；
   ③ `RecentImages` 的 chat 键随聊天数增长（`src/emoji/collection.ts:238`）。
8. **`state.lock` 的 `stale: 30_000`**（`src/state-lock.ts`）：进程被 suspend 超过 30 秒后锁可被抢占，
   出现双写者。窗口不大，但锁持有期没有上限。
9. **`findExistingSession` 改取「最近」而非「最丰富」的候选**（`src/session/manager.ts`），
   候选还新增了按标题 `QQ 群 <id>` / `QQ 私聊 <id>` 匹配 —— 别的项目里同名的会话可能被接管。
   建议：标题匹配只在元数据匹配不到时兜底，并校验会话目录。
10. **`CollectionStore` 信任存储里的 `file` 字段**（`src/emoji/collection.ts:148-167`），
    超限时直接 `unlink()`（`:122-132`）。插件存储被污染即可删任意文件。建议落盘时校验路径在收藏目录内。
11. **`qq_collect_sticker` 落在 `qq_*` 允许列表里**（`src/tools/qq.ts`），普通群成员即可触发；
    动图按普通图片发送（无 `sub_type`），QQ 侧多半转成静态图，与「收藏动图」的预期有落差。
12. **CI 的「隐私扫描」只跑 `CustomRegex` 且带 `--no-verification`**（`.github/workflows/release.yml`），
    既不覆盖其它检测器也不校验发现，强度低于这个步骤名字给人的印象。
    `scripts/trufflehog.yml` 另新增 4 条 allowlist（面板/napcat/查询串测试令牌）。

**已修复**：12 条逐条处理：

1. `maskDocument()` 改用 `Object.defineProperty` 重建对象，`__proto__` 等键原样保留；
2. 已知密钥命中即掩码，不再看长度（≥4 字符），自设短令牌不会回显；
3. `src/fs/atomic.ts` 写入前 `lstat`，目标是符号链接直接拒绝（`write-file-atomic` 会 realpath 到链接目标）；
4. rename 之后 fsync 父目录，模块注释改成与实现一致的崩溃安全表述；
5. 两个新 PUT 端点与 `/api/config` 一致：要求 `application/json`（否则 415），带 Cookie 的非安全请求必须带 Origin；
6. 两个文档的未知字段统一为「告警 + 忽略」（200），`docs/panel.md` 的说法与实现对齐；
7. `turnClearedAt` 上限 256、`SoulLibrary` 缓存上限 32、`RecentImages` 跟踪的 chat 上限 64；
8. `state.lock` 过期时间改为 120s、心跳间隔 30s，降低误抢占；
9. 标题匹配只在工作区内生效且仅在元数据匹配不到时兜底；`reuseSession` 取「最近」，`recoverSession` 取「最丰富」；
10. `CollectionStore` 落盘与删除前都校验路径在收藏目录内，越界条目直接忽略；
11. `qq_collect_sticker` 移入 `ADMIN_DENY` / `ADMIN_ONLY`，仅管理员/群主可用；`docs/emoji.md` 注明动图按静态图发送；
12. CI 的隐私扫描加 `--fail` 阻断，并新增一步跑全部检测器（`--only-verified --fail`）。

---

## 值得肯定的部分

- **面板鉴权链路扎实**：全部 `/api/*` 走 `secureHeaders`（CSP）+ 非安全方法的 Origin 检查 +
  hono `csrf` + Bearer/会话 Cookie 鉴权；`timingSafeEqual` 比等长哈希；
  Cookie 是 `HttpOnly + SameSite=Strict`；敏感字段只回 `hasValue`。
- **配置注册表仍是唯一事实源**：面板新增的两个页面没有另写一套校验规则，
  一律复用运行时的 `parseChatOverrides()` / `parseToolPolicy()`——
  高危 1 与中危 11 正是因为「复用了运行时解析器、但运行时解析器本身有洞」才暴露出来。
- **落盘姿势是对的**：`src/fs/atomic.ts` 用「临时文件 + fsync + rename」，文件 0600、目录 0700，
  另有同样 0600 的 `.bak` 备份；`src/config/store.ts` 改用它之后没有引入格式回归。
- **会话绑定不会互相覆盖**：`bindSession()` 同时检查「同一目标已绑别的会话」与「同一会话已绑别的目标」；
  `27a46fc` 的版本化绑定 + 墓碑机制在「谁最后写谁赢」这件事上是对的，
  跨进程写锁（`src/state-lock.ts`）的方向也正确，只是失败路径没兜住（中危 5）。
- **机器锁先于共享状态**：`src/index.ts` 的启动顺序是
  `claimInstance()` → `panel.start()` → 机器锁 → 运行时初始化，
  `SessionManager` 构造时 `canWrite()` 一定为真，`writable()` 的失效路径也是对的。
- **`OutboundMedia.check` 用词法路径与 realpath 双重校验**（`src/media-path.ts`），
  收藏表情的本地文件路径能过白名单，任意路径过不了。
- **收藏表情的边界做得细**：描述校验（只允许文字数字、≤12 字）、md5 去重、数量上限 200、
  目录 0700 / 文件 0600、超限时连文件一起删。

---

## 建议的修复顺序（已按此执行）

1. **高危 1**：`PROFILE_NAME` 排除原型属性名，并把 `parseToolPolicy()` / `parseChatOverrides()`
   的映射改成 `Object.create(null)` —— 根因在解析器，不在面板。
2. **高危 2**：新建与编辑分开请求体语义；服务端对「不存在的键 + 全 null」明确拒绝。
3. **高危 3**：路径**规范化**（`resolve` + `realpath`）后与允许根比较，允许根做成配置项；
   真正的闸门加在**内容**上——大小上限 + `SensitiveChecker` 拦截 + `maskKnownSecrets` 掩码。
   不禁止绝对路径，功能不砍。
4. **高危 4**：面板两次保存复用 `src/state-lock.ts`。
5. **中危 9**：告警去重（或 key 换索引）—— 一行修复，直接消除白屏。
6. **中危 5 / 6**：写锁失败真正重试；绑定表清理。
7. **中危 10 / 11 / 12 / 13**：两个新页面对齐 `ConfigPage.svelte` 的既有做法
   （`EMPTY_CHOICE` 哨兵、删除时自动解引用、保存时保留其它顶层键）。
8. **补测试**：`tests/panel-documents.test.ts` 现有的断言都用 `toMatchObject`（部分匹配），
   高危 2 这类「字段被整体清空」的问题会被它放过。建议补三例：
   - 原型属性名必须被拒绝（`__proto__` / `constructor`）；
   - 角色设定文件里含私钥样式内容时必须**拒绝加载**，且不能进提示词；
   - 写一个同名键的稀疏补丁不能清掉该键的既有字段。
9. **中危 7**：令牌吊销语义补进 CHANGELOG 与 `docs/panel.md`。
10. **中危 8**：面板默认开启是既定决策，只补文档——CHANGELOG 点名这次默认值变更，
    `docs/panel.md` 与 README 写清怎么关掉、令牌在哪看、别把 `panel.host` 改成 `0.0.0.0`。
