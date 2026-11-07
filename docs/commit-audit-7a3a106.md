# 提交审计：7a3a106..c90b2bc

> 状态：审计完成，未改动代码。范围内 7 个提交，发现 2 个高危、5 个中危、若干低危问题。

审计范围：`7a3a1069ad0fdd200f24f1c86af7cae35a095746` 及其之后的提交，直到 `c90b2bc`（发布 0.4.0）。
更晚的提交（`c90b2bc..HEAD`）另见 [commit-audit-c90b2bc.md](./commit-audit-c90b2bc.md)。

| 提交      | 内容                                                              |
| --------- | ----------------------------------------------------------------- |
| `7a3a106` | 队列投递对齐上游会话状态，busy 改读上游事件，移除 `busyTimeoutMs` |
| `8f09f02` | 去掉轮询式 resume，补 `idleIsStale()` 过期事件保护                |
| `c4b1f1b` | 会话提示的 id 改用 `SessionMessage.ID.create()`                   |
| `be93390` | 失败批次冻结为 `pending`，重试保持同一 payload                    |
| `b27741c` | 新增 `src/bot-lock.ts`，同一机器人只允许一个实例消费消息流        |
| `c28d19a` | 新增 `src/emoji/`，收藏表情自动打标签与按编号发送                 |
| `c90b2bc` | 发布 0.4.0                                                        |

验证基线：`tsc --noEmit` 通过，`eslint .` 无告警，`vitest run` 18 个文件 / 295 个用例全绿。

上游核对：OpenCode `dev` 分支 `packages/core/src/location-activity.ts`、`location-lifecycle.ts`、
`bus.ts`、`plugin/host.ts`、`packages/server/src/handlers/session.ts`、
`@opencode/schema/dist/session-event.d.ts`、`session-status-event.d.ts`；
锁实现核对 `node_modules/@bybrave/proper-lockfile2/lib/lockfile.js`。

---

## 高危

### 1. 收藏表情的第三方描述未净化就进入提示词

`src/naplink/render.ts:63-69` 的 `imagePlaceholder()` 对收藏表情（`sub_type === 1`）直接返回
NapCat 给的 `summary`（即表情主人写的描述），没有任何净化；该文本经 `src/naplink/render.ts:396-397`
进入 `rendered.text`，再由 `src/index.ts:203-216` 的 `formatModelMessage` 拼进提示词。
同一条未经净化的描述还经 `src/emoji/favorites.ts:36-38` 的 `faceTag()` 进入
`formatFavoriteList` / `formatFavoriteIds`，出现在 `qq_favorite_list` 的工具输出与
`qq_send_sticker` 的报错文本里（`src/tools/qq.ts`）。

这绕开了 `4fba751` 建立的入站净化层：表情主人可以把描述写成 `<quote>` / `</history>` 一类结构标签
或任意指令，直接进入提示词。`docs/emoji.md:92-93` 只说明“摘要会保留在提示词里”，没有提及净化。

建议：对 `summary` 与 `desc` 复用 `sanitizeUntrustedText`（`src/model-view.ts:24-31`）后再输出。

位置：`src/naplink/render.ts:63-69`，`src/emoji/favorites.ts:36-38`，`src/tools/qq.ts`（`qq_favorite_list` / `qq_send_sticker`）

### 2. `pending` 批次没有重试上限也没有兜底，目标可能永久静默

`src/session/manager.ts:453-459` 的 `drain()` 先重试 `state.pending`，失败即 `return`；
失败批次在 `src/session/manager.ts:477-480` 被冻结回 `state.pending`。

如果上游永久拒绝该 id（例如与已存在但内容不同的消息冲突），`drain()` 每次都提前返回，
缓冲区里的新消息永远不会被投递，该目标从此不再响应。`pending` 也没有持久化，
重启后这一批内容直接丢失，只有历史回填可能兜回来。

建议：给 `pending` 记录失败次数，超过阈值就丢弃该批次并写错误日志，同时照常投递缓冲区内容。

位置：`src/session/manager.ts:453-459,477-480`（`ChatState.pending` 定义在 `src/session/manager.ts:69`）

## 中危

### 3. `resumeBuffered()` 变成死代码，“执行结束事件丢失”的兜底消失

`8f09f02` 删掉了 `src/index.ts` 里的 60s 轮询定时器，`resumeBuffered()`
（`src/session/manager.ts:633-638`）因此在生产路径上不再有调用点，只剩 `tests/manager.test.ts`
在调用——测试给出了“已覆盖”的错觉。

结果是：一旦 `session.execution.succeeded/failed/interrupted` 事件丢失，缓存的消息会一直压到
下一条入站消息触发 `drain()` 为止，没有兜底轮询。

建议：要么恢复一个低频兜底定时器，要么让入站路径无条件检查缓存。

位置：`src/session/manager.ts:633-638`，`src/index.ts`（`8f09f02` 删除了 `resumeTimer`）

### 4. 身份锁抢占与插件卸载存在竞态

`src/index.ts:271-285` 的 `claimBot()` 不检查 `disposed`（`src/index.ts:337-340` 只在 `dispose()`
内部设置）。若卸载与抢锁并发发生：

- 抢锁成功后会在 `src/index.ts:283` 调用 `startConsuming()`，即在插件已经卸载后重新连接 NapCat；
- 锁句柄没有交回 `dispose()`，锁目录残留，只能等 30s 过期窗口后由接管方清理。

建议：`claimBot()` 开头检查 `disposed`；抢锁成功后若已 disposed，立即释放锁并返回。

位置：`src/index.ts:271-285`、`src/index.ts:337-358`

### 5. 首次 `claimBot()` 没有兜底异常，锁目录异常会让插件整体加载失败

`src/index.ts:287` 的 `const claimed = await claimBot()` 没有 `try/catch`；
`src/bot-lock.ts:81-85` 只把 `ELOCKED` 视作正常，其余错误全部抛出。
tmpdir 不可写、权限不足等异常会直接中断插件初始化，插件完全不加载（而不是退化成“不消费消息”）。

建议：初始化阶段捕获错误并降级为“本实例不消费消息 + 定时重试”。

位置：`src/index.ts:287`，`src/bot-lock.ts:81-85`

### 6. 锁心跳窗口对同进程插件偏紧，事件循环卡顿会误判失锁

`src/bot-lock.ts:19-21` 取 `STALE_MS = 30_000`、`UPDATE_MS = 10_000`。
`proper-lockfile2` 在心跳连续失败超过阈值后判定锁失效并触发 `onCompromised`
（`node_modules/@bybrave/proper-lockfile2/lib/lockfile.js:179-264`），此时锁目录不会删除，
只能等 30s 过期后由接管方回收。

插件与 OpenCode 同进程，一旦事件循环被阻塞超过 30s（长耗时同步任务、同步大文件读写等），
即使没有第二个实例，也会误判失锁：插件立刻停止消费 QQ 消息（`src/index.ts:273-279`），
并且要等“30s 过期 + 30s 重试间隔”才能恢复，静默约 30~60s。

建议：把 stale 放大到分钟级（例如 120s），并在 `onCompromised` 里区分“他人接管”与“自身卡顿”。

位置：`src/bot-lock.ts:19-21,63-70`，`src/index.ts:273-279,296-301`

### 7. 释放锁失败会中断卸载，实例租约无法释放

`src/index.ts:356` 的 `await botLock?.release()` 只在 `src/bot-lock.ts:75-78` 吞掉 `ERELEASED`，
其它错误（如删除锁目录时的 `EACCES`）会抛出，导致后面的 `lease.release()`
（`src/index.ts:358`）不执行。实例租约被持有后，插件重载或被 `claimInstance` 接管会失败。

建议：`dispose()` 里对 `botLock?.release()` 单独 try/catch，确保 `lease.release()` 一定执行。

位置：`src/index.ts:356-358`，`src/bot-lock.ts:71-79`

## 低危 / 提示

- **表情标签只取模型回复的最后一段**：`src/emoji/label.ts:112-121` 的 `push()` 与
  `src/emoji/label.ts:123-147` 的 `awaitText()` 都只取缓冲区最后一段文本，
  模型分多段输出时标签会丢掉开头，可能变成残缺或错误的标签。
- **卸载后标注任务不会真正停下**：`src/emoji/command.ts:164` 的 `void runLabeling(...)` 在后台循环，
  循环体（`src/emoji/command.ts:116-126`）不检查中止信号；`labelFace`
  （`src/emoji/label.ts:230-267`）也不检查 `this.abort.signal`。插件卸载时 `labeler.dispose()`
  只 abort 了监听循环（`src/emoji/label.ts:83-85`），已排队的标注仍会继续为剩余表情发起模型请求，
  每次最多再等 60s，最长可拖到几十分钟并持续消耗额度；期间发往 QQ 的进度消息只会写日志。
- **编号索引读失败后不再重试**：`src/emoji/favorite-index.ts:117-120` 的 `ensureLoaded()` 永久缓存
  首次读取的 Promise，而 `read()` 在 `src/emoji/favorite-index.ts:122-130` 内吞掉异常，
  一次临时存储读取失败就会让索引长期为空、编号从 1 重新分配，
  与 `docs/emoji.md:54`“被删掉的收藏表情留下的编号不会再分配给别人”矛盾。
- **`refresh:true` 在有请求进行中被忽略**：`src/emoji/favorites.ts:93-104` 的 `list()` 在
  `inflight` 存在时直接复用旧请求，`refresh` 不生效。
- **标注成本没有提示**：每个表情一次模型调用，最多 48 个（`src/emoji/favorites.ts:31`），
  `docs/emoji.md` 未提示这部分开销。
- **文档里的接口上限缺依据**：`docs/emoji.md:86` 断言 `fetch_custom_face_detail` 的 `count` 上限为 48，
  未见可核对的来源。
- **CHANGELOG 的“已废弃”表述不准**：`0.3.2` 称 `session.idle` 已废弃，
  但 `@opencode/schema` 2.2.5 仍定义该事件（`session-status-event.d.ts:126`）。
  插件现在监听的 `session.status` 与三个 execution 事件在 schema 中都存在，方向是对的。

## 核对通过的部分

- **`session.status` 事件可用**：`@opencode/schema` 2.2.5 定义了
  `session.status`（`session-status-event.d.ts:35`），status 联合类型为
  `idle | retry | busy`；`src/index.ts:148-176` 的订阅与 `event.data.status.type === "idle"`
  的判断与上游一致。
- **提示 id 合法**：`c4b1f1b` 改用 `SessionMessage.ID.create()`
  （`src/session/manager.ts:394`），产出 `msg_` 前缀 id，`tests/manager.test.ts` 有对应断言。
- **过期事件保护有效**：`idleIsStale()`（`src/session/manager.ts:436-447`）比较上游 `time.idle`
  与本地 `state.lastDispatchAt`，能挡掉迟到的 idle 事件。
- **单实例互斥的基本面正确**：锁目录用 `sha256(url + token)` 命名，不泄漏令牌；
  `ELOCKED` 视作“别人在用”（`src/bot-lock.ts:83`），`ERELEASED` 视作“锁已失效”（`src/bot-lock.ts:77`）；
  进程崩溃后锁目录在 stale 窗口后被 `reclaimStaleLock` 接管，不会永久卡死。
- **收藏表情编号不会重复**：`src/emoji/favorite-index.ts` 的 `sync()` 是同步循环，
  按首次出现顺序分配、复用已分配编号，写盘用 mutex 串行化。
- **`/emoji-label` 参数解析稳健**：`src/emoji/command.ts:33-41` 兼容 `/emoji-label all`、
  `emoji-label all`、`all` 三种写法。

---

## 与另一份审计的关系

两份审计覆盖同一信任边界，建议一起修：

- 本文件高危 1（表情描述绕过净化）与 [commit-audit-c90b2bc.md](./commit-audit-c90b2bc.md)
  的高危 1（净化逐段执行）都是入站净化缺口，修复时应收敛到同一处入口。
- 本文件高危 2（`pending` 无上限）与该文件的高危 2（历史补页缺 `reverse_order`）都会让消息
  重复或丢失，同属投递可靠性。

跨两份审计的建议修复顺序：

1. 入站净化两处缺口（表情描述、逐段净化）
2. 投递可靠性两处缺口（`pending` 无上限、`reverse_order` 缺失）
3. 锁相关中危（死代码 `resumeBuffered`、卸载竞态、初始化异常、心跳窗口、释放顺序）
4. 许可合规、出站丢内容（表格吞行、首部空行）、文档补登
5. 低危项与文档修订

涉及行为的修复需补回归用例，用例放在 `tests/` 下。
