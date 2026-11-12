# 提交审计：4d05341..HEAD

> 状态：审计完成。范围内 6 个提交（配置体系重构 + 状态面板 + 会话恢复改造 + 2 次发布 + 2 份设计文档），
> 发现 3 个高危、5 个中危、7 个低危问题。高危 3 条与中危 4、5 都实测复现过，复现步骤写在各条里。
> 修复状态：全部待处理。

审计范围：`4d053417aca031b1c10876d5686982775bbbd6b2` 之后的全部提交，直到 `50f1ccc`。

| 提交      | 内容                                       |
| --------- | ------------------------------------------ |
| `ff323bf` | 绑定的会话读不到时先找回再换绑，不直接重建 |
| `b4a729f` | 发布 0.7.1                                 |
| `09298f7` | 发布 0.8.0                                 |
| `362799d` | 记录队列、上下文与超时问题的候选方案       |
| `f02ae78` | 配置中心与状态面板的设计文档               |
| `50f1ccc` | 实现配置中心与状态面板                     |

变更规模：125 个文件，+9110/-1879。三块主线：

- **配置体系重构**：`src/config.ts`（1100 行）拆成 `src/config/{fields,registry,store,live,types}.ts`，
  配置来源从「环境变量 + 插件选项」收敛为固定目录下的 `config.json`；`src/home.ts` 的工作目录不再可配。
- **新增状态面板**：`src/panel/{api,auth,models,runtime,server,status}.ts` + `web/`（Svelte 5 + Vite + Tailwind v4）。
- **会话恢复改造**：`src/session/find.ts`、`src/session/manager.ts`。

验证基线（HEAD `50f1ccc`，工作区干净）：

- `bun run typecheck`（`tsc --noEmit`）通过，无输出。
- `bun run lint`（`eslint`）通过，无告警。
- `bun run test`（`vitest run`）44 个文件 / 835 个用例全绿（2.6s）。

---

## 修复状态

| 编号   | 问题                                            | 状态   |
| ------ | ----------------------------------------------- | ------ |
| 高危 1 | 面板端口冲突导致 OpenCode 进程崩溃              | 待处理 |
| 高危 2 | 面板保存可把配置写成「下次启动即死」            | 待处理 |
| 高危 3 | 面板改过一次端口后配置订阅就断了                | 待处理 |
| 中危 4 | 面板默认关闭时改配置打开不会生效                | 待处理 |
| 中危 5 | 多余实例提前启动面板并泄漏监听                  | 待处理 |
| 中危 6 | `events.subscribe` 标了热字段但实际不热         | 待处理 |
| 中危 7 | `reuseSession` 找的是「消息最多」不是「上一个」 | 待处理 |
| 中危 8 | 面板令牌明文进日志文件                          | 待处理 |
| 低危   | 见下文「低危 / 提示」                           | 待处理 |

---

## 高危

### 1. 面板端口冲突会直接崩掉 OpenCode 进程

`src/panel/server.ts:116` 用 `serve({ fetch, hostname, port })` 起 HTTP 服务，但**没有挂 `'error'` 监听**：

```ts
const server = serve({ fetch: app.fetch, hostname: host, port })
server.unref?.()
```

`@hono/node-server` 的 `serve()` 在端口被占用时不会同步抛错，而是让 `http.Server` 异步 emit `'error'`。
事件在 `serve()` 返回之后才发生，外层的 `await` 已经 resolve，`.catch()` 也接不到 → 变成 uncaught exception。

实测（`/tmp/opencode/verify-panel4.ts`）：两个 `PanelServer` 监听同一端口，第二个实例的 `start()`
**resolve 成功**，随后进程直接挂掉：

```
UNCAUGHT EXCEPTION: Failed to start server. Is port 7421 in use?
```

这条路径在真实场景里可达，不是构造出来的边角：`src/index.ts:214` 的 `await panel.start()` 早于
`:226` 的 `claimInstance()`。OpenCode 为不同项目目录加载同一个插件时，第二个实例会**先占端口**、
再发现自己绑在别的目录上（见中危 5）。

影响：不是「面板起不来」，而是**整个 OpenCode 进程退出**，用户的其它会话一起没。

建议：

1. 把 `listen()` 包成 Promise，给 `server` 挂 `'error'` 监听，`EADDRINUSE` 时 reject 而不是崩进程；
2. 面板启动挪到 `claimInstance()` 之后，只在确认自己是有效实例后才监听端口；
3. 端口被占用时降级为「面板不可用」的 warn 提示，不影响机器人主体运行。

位置：`src/panel/server.ts:104-124`、`src/index.ts:214`

### 2. 面板保存可以把配置写成「下次启动即死」

`src/config/live.ts:87-101` 的 `applyPatch()` 顺序是**先落盘、后校验**：

```ts
const raw = await this.options.store.patch(patch)
await this.options.store.write(raw) // ← 文件已经改了
this.raw = raw
const next = this.resolve(raw) // ← 这里才校验，可能抛
```

`resolve()` 抛错时，磁盘上的 `config.json` 已经是坏的了，内存配置却还停在旧值。
而 `src/config.ts` 的 `resolveConfig()` 在 `napcat.url` 缺失时是直接 throw 的——
「未配置 NapCat WebSocket 地址」，插件下次启动就退出了。

实测（`/tmp/opencode/verify-panel3.ts`）：面板 PUT `{"napcat.url": null}` →

- 接口返回 **HTTP 500 `write_failed`**（看起来像「没生效」）；
- 磁盘上的 `config.json` 已经变成 `{"napcat":{}}`；
- 内存配置仍是旧 url，面板继续显示正常；
- 重新 load 抛「未配置 NapCat WebSocket 地址」。

只有 `.bak` 里还有旧值可以救。

前端是共犯。`web/src/routes/ConfigPage.svelte` 的 `normalize()` 把空的 text 类字段规整成 `null`
（`null` 在 `ConfigStore.patch()` 里表示**删键**），而 `src/config/registry.ts` 生成的 JSON Schema
**没有 `required` 数组**，`web/src/routes/ConfigPage.svelte` 里的 ajv 校验因此拦不住「把必填项删掉」。
`web/src/lib/api.ts` 也没有对必填字段做单独判断。

建议：

1. `applyPatch()` 改成**先 `resolve()` 校验、再落盘**，校验不过就不碰文件；
2. 必填字段（如 `napcat.url`）不允许删除：`null` 直接拒绝并报错，而不是当删键处理；
3. `configJsonSchema()` 补 `required`，前端校验才有意义。

位置：`src/config/live.ts:87-101`、`src/config/registry.ts`、`web/src/routes/ConfigPage.svelte`

### 3. 面板改过一次端口后，配置订阅就断了

`src/panel/server.ts` 把「订阅配置变化」和「HTTP 监听」的生命周期绑在了一起：

- `start()`（`:59-69`）：`this.unsubscribe ??= controller.onChange(...)`，然后 `listen()`；
- `stop()`（`:72-82`）：`this.unsubscribe?.(); this.unsubscribe = undefined`，然后关服务器；
- `reconcile()`（`:85-101`）：host/port 变了 → `await this.stop()` → `await this.listen()`。

于是改端口这条路径会把订阅一起清掉，`listen()` 又不会重新订阅（订阅只在 `start()` 里做）→ 面板从此不再响应配置变化。

实测（`/tmp/opencode/verify-panel.ts`）：

| 步骤              | 期望                   | 实际                        |
| ----------------- | ---------------------- | --------------------------- |
| 改 `panel.port`   | 换端口                 | ✅ 新端口正常监听           |
| 改 `panel.token`  | 旧令牌失效、新令牌可用 | ❌ 旧令牌仍 200，新令牌 401 |
| 再改 `panel.port` | 换端口                 | ❌ 仍监听旧端口             |

安全后果不只是「改不动」：面板换了新令牌，但**旧令牌依然有效**——管理员以为已经轮换掉了，实际没轮换。

建议：把订阅从 `start()`/`stop()` 里拆出来，由 `PanelServer` 的构造或独立的 `subscribe()` 管；
`stop()` 只负责关 HTTP 服务与作废会话，不碰订阅。另外 `reconcile()` 里改令牌时应当
先 `rotate()` 再比对，否则 `this.token` 初值与配置不一致时会误判。

位置：`src/panel/server.ts:59-101`

---

## 中危

### 4. 面板默认关闭时，改配置打开不会生效

`src/panel/server.ts:59-64`：

```ts
if (!config.panel.enabled) {
  this.options.logger.debug("状态面板未启用")
  return // ← 没有订阅配置变化
}
```

`panel.enabled` 在注册表里标了 `hot: true`（`src/config/fields.ts`），`docs/panel.md` 也写明面板自身设置可热更新。
但启动时 `enabled` 为 false 就直接 return，之后**没有任何人订阅配置变化**，把 `enabled` 改成 true 也不会启动面板。

实测（`/tmp/opencode/verify-panel2.ts`）：启动时 `panel.enabled=false` → 无论用 `applyPatch` 改还是直接改文件，
面板始终不启动，只能重启插件。

建议：`start()` 无论 `enabled` 与否都先订阅，`reconcile()` 里负责「要不要真的监听」。

位置：`src/panel/server.ts:59-69`

### 5. 多余实例提前启动面板并泄漏监听

`src/index.ts` 的启动顺序：

```
:214  await panel.start()        // 面板已经在监听端口
:220  await controller.startWatching()   // chokidar 已经在盯文件
:226  const { previous, occupied, lease } = claimInstance(...)
:230  if (occupied) { logger.warn(...); await closeLogger(logger); return }
```

`:230` 的 return **没有经过 `cleanup`**（cleanup 在 `:245` 才建），于是：

- 面板的 HTTP 服务继续占着端口不释放；
- chokidar 的文件监听继续跑；
- 日志器已经被 `closeLogger()` 关掉，面板后续再写日志用的是已关闭的 logger。

这跟高危 1 是同一条链：多余实例先占端口 → 有效实例起面板时 EADDRINUSE → 崩溃。

建议：把 `claimInstance()` 提到面板启动之前；`occupied` 分支要走完整的 cleanup 流程再返回。

位置：`src/index.ts:214-234`

### 6. `events.subscribe` 标了热字段但实际不热

`src/index.ts:978-989`：

```ts
let subscribed = false
const startConsuming = async () => {
  if (!subscribed) {
    subscribed = true
    client.onGroupMessage(scheduleMessage)
    client.onPrivateMessage(scheduleMessage)
    if (config.events.subscribe.includes("notice")) {
      client.onNotice(scheduleNotice)
    }
  }
  await client.connectSafe()
}
```

`subscribed` 保证监听只注册一次，于是：

- 启动时 `subscribe` 不含 `notice` → 之后改配置加上 `notice`，**不会补订阅**；
- 启动时含 `notice` → 之后改配置去掉 `notice`，**监听也不会摘掉**，通知照收。

两个方向都错。`events.subscribe` / `events.notices` / `events.inject` 在注册表里都标了 `hot: true`，
实际只有 `events.notices` / `events.inject`（每次事件现读）算真的热。

建议：重连时重新按当前配置决定订阅集合；或者把 `events.subscribe` 从热字段清单里去掉，
让面板明确提示「需重启」。

位置：`src/index.ts:978-989`、`src/config/fields.ts`

### 7. `reuseSession` 找的是「消息最多」不是「上一个」

`src/session/manager.ts:1706-1712`：

```ts
/** 查找带相同目标标记的历史会话，按消息最多的那条优先。 */
private async findExistingSession(target: ChatTarget): Promise<string | undefined> {
  const candidates = await this.findSessionCandidates(target)
  if (candidates.length === 0) return undefined
  const best = await this.pickRichestSession(candidates)
  return best?.id
}
```

`ff323bf` 之前这里返回的是**最近**的一条（列表按时间倒序取第一个）。现在改成在 5 个候选里挑**消息最多**的。

两处问题：

1. **语义变了。** 字段说明（`src/config/fields.ts`，`reuseSession`）写的是「完全没有绑定时，按会话标记找回**上一次的**会话」，
   CHANGELOG 里也只写了「历史会话的查找窗口从 500 条扩到 4000 条」，没提选择规则变了。
   「上一次」应该是时间上最近的那条；消息最多的那条可能是几天前的一条旧会话。
2. **开销落在消息路径上。** `pickRichestSession()` 为了数消息，对**每个候选**调 `ctx.session.context({ sessionID })`，
   那会把该会话的完整上下文拉进内存。5 个候选就是 5 份全量上下文，只为了取个长度。

建议：恢复路径（`recoverSession()`）用「消息最多」是有道理的——要的是最完整的那段历史；
但 `reuseSession` 路径应该取「最近的一条」，两者不必共用 `pickRichestSession`。
如果确实要按消息数排序，可以只读会话的元数据行数，不要拉全量上下文。

位置：`src/session/manager.ts:1706-1712`、`src/config/fields.ts`（`reuseSession`）

### 8. 面板令牌明文进日志文件

`src/index.ts:193-202` 生成令牌后直接打进日志：

```ts
const token = randomBytes(32).toString("hex")
await controller.applyPatch({ "panel.token": token })
logger.warn("面板访问令牌已生成（已写入 config.json）", token)
```

而 `src/index.ts:102-108` 的 `knownSecrets()` 只收集了三类：

```ts
...collectEnvSecrets(process.env),
config.napcat.token ?? "",
...secretsFromUrl(config.napcat.url),
```

**不含 `panel.token`**。于是令牌会原样进 `logs/*.log`，也会原样出现在面板的日志页
（`src/logger.ts` 的环形缓冲走同一条 `maskSecrets` 链路）。

`docs/panel.md` 把「启动日志里打印一次明文」记成了设计决定。打印一次本身可以接受，
问题在于**它没有被标记为已知密钥**，所以任何一次日志外发（贴给同事、发到群里、截图）都等于面板失守——
面板是全权控制入口，令牌泄露 = 机器人配置与日志全暴露。

建议：把 `config.panel.token` 加进 `knownSecrets()`（日志里显示为 `[REDACTED]`），
需要看明文就直接去读 `config.json`（权限 0600）；或者只打印「令牌已生成，请查看 config.json 的 panel.token」。

位置：`src/index.ts:102-108`、`src/index.ts:193-202`

---

## 低危 / 提示

1. **`.gitignore` 收窄过头。** 删掉了 `.env.*` 与 `!.env.example`，现在只忽略 `.env`。
   `.env.local`、`.env.production` 这类同样含真实令牌与群号的文件不再被忽略，容易误提交。
   建议保留 `.env*` 并单独 `!.env.example`。
2. **`docs/panel.md:59` 的示例配置带 `"version": 1`**，但注册表里没有 `version` 字段，
   `warnUnknownFileKeys` 每次加载都会告警「未知配置项：version」，且该键会被原样保留在文件里。
   要么把 `version` 注册成字段，要么改文档。
3. **`src/home.ts:45` 的 `resolvePath(base, value)` 是死代码**，没有任何调用点（`expandTilde` 仍在被 `src/media-path.ts` 使用）。
4. **NOTICE 与实际依赖不符。** NOTICE 把 `@internationalized/date` 列在「随前端产物分发的依赖」里，
   但 `web/src` 里没有任何地方引用它，它只是 `web/package.json` 的 devDependency。
5. **`web/vite.config.ts` 的 dev proxy 把 `7391` 写死**（`proxy: { "/api": "http://127.0.0.1:7391" }`），
   面板换端口后前端开发模式连不上后端。
6. **cleanup 名字重复**：`"取消配置订阅"` 在 `src/index.ts:257` 与 `src/index.ts:417` 各注册一次，
   日志里两条同名步骤无法区分（前者是日志级别订阅，后者是敏感检查开关）。
7. **两处小瑕疵**：
   - `src/index.ts:159` 的 `agentFromOptions(ctx.options)` 调用了两次；
     `applyPatch` 产生的 warnings 进了数组但那时已经打印完，永远不会输出。
   - `src/diary/scheduler.ts` 的 `lastTick` 在 mutex 内赋值，「还没到总结时刻」也会记成一次 tick，
     状态面板的 `nextRunAt` / `lastRunAt` 因此和真实的总结时间对不上。

---

## 值得肯定的部分

- **配置注册表是唯一事实源**：`src/config/fields.ts` 一处生成默认值、zod schema、JSON Schema、文件键集合与热字段清单，
  面板表单也是从它生成的，不存在第二份字段定义。
- **配置文件的落盘姿势是对的**：`write-file-atomic` + `fsync`，文件 0600、目录 0700，另有同样 0600 的 `.bak` 备份。
- **面板的鉴权链路扎实**：`timingSafeEqual` 比等长哈希、HttpOnly + SameSite=Strict Cookie、
  写接口同时校验 Origin 与 CSRF、CSP 头、敏感字段只回 `hasValue` 不回明文。
- **会话绑定不会互相覆盖**：`bindSession()` 同时检查「同一目标已绑别的会话」与「同一会话已绑别的目标」。
- **日志环形缓冲过 `maskSecrets`**，敏感信息不会直接进内存缓冲。

---

## 建议的修复顺序

1. 高危 1 + 中危 5：面板 server 挂 `'error'` 监听、把启动挪到 `claimInstance()` 之后、`occupied` 分支走完整 cleanup。
2. 高危 2：`applyPatch()` 改成先校验后落盘；必填字段禁删；JSON Schema 补 `required`。
3. 高危 3 + 中危 4：订阅与 HTTP 监听解耦；`enabled=false` 时也订阅。
4. 中危 8：`panel.token` 进 `knownSecrets`。
5. 中危 6、7 与低危项按维护者裁定处理。
6. **补 `PanelServer` 的生命周期测试**：`tests/panel.test.ts` 现在只测 `createPanelApp`，
   `start` / `stop` / `reconcile` 一个都没测，高危 1、3、4、中危 4 全都落在这个缺口里。
   至少补：端口占用时 reject 而不是崩进程、改端口后仍能响应配置变化、`enabled` 从 false 变 true 能启动。
