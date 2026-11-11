# 已知问题

记录已复现但还没修掉的问题，避免同样的坑再踩一遍。

## 重启后消息卡在队列，上游收不到新消息

### 现象

- 插件重启（进程重启、热重载、OpenCode 更新）之后，某个聊天不再回复新消息。
- 日志里能看到「收到 QQ 消息」，但没有「已投递消息到会话」；追踪文件里只有
  `event_received`，没有 `agent_start`。
- 消息一直堆在插件自己的队列里，队列长度持续增长。

### 触发条件

1. 上游会话里有一轮还没结束（模型在跑，或者被中断后上游仍认为 busy）。
2. 插件重启，`restoreInflight()` 恢复出「在途轮次」（`state.current` 非空）。
3. 之后进来的消息入队后，`deliver()` 判定上游仍在执行，消息被扣在本地队列里。

### 根因

阻断点在 `src/session/manager.ts` 的 `deliver()`：

```ts
if (!force && state.sessionID && this.verifiedSessions.has(state.sessionID)) {
  if (await this.sessionRunning(state.sessionID)) {
    // 上游仍在执行，保留在队列
    return
  }
  ...
}
```

`sessionRunning()` → `upstreamRunning(time)`，只看 `time.busy > time.idle`。

按上游 schema 的定义（`@opencode/schema` 的 `Session.time`）：

- `time.busy`：最近一次执行的**开始**时间；执行期间 `time.idle` 还是上一轮的结果。
- `time.idle`：最近一次**完成**的执行的结束时间。
- 「重启后恢复会话会开启一次新的执行」。

于是：重启后上游恢复会话会开一次新的 execution；如果这次执行卡住（模型没跑完、
工具没结束，或者恢复后空转），`time.busy` 就一直停在开始时间、`time.idle` 不更新，
插件永远认为「上游还在跑」，队列里的消息永远投不出去。

第二个问题：重启恢复出来的「在途轮次」让插件以为这一轮还在跑——`activeTurn()` 非空，
发送去重守卫按「这一轮已经回复过」处理，`awaitingSend` 与上游的真实进度也对不上。

### 影响

- 该聊天不再回复新消息；消息只进本地队列。
- 队列有上限（`MAX_BUFFER_TURNS` = 100），超出后新消息直接被丢弃。

### 诊断要点

- info 级日志（已把收发关键节点提到 info，正在发布中）：
  「收到 QQ 消息」「消息已入队（累计 N 条）」「上游仍在执行，保留 N 条消息」
  「已投递消息到会话」。
- 追踪文件：只有 `event_received`、没有 `agent_start`，说明消息没投进上游。
- 上游状态：`ctx.session.get()` 的 `time.busy` / `time.idle` / `time.updated` / `outcome`。
- 在 TUI 里手动 interrupt 那个会话通常能立刻恢复。

### 已评估并被否决的方案

1. **超时即打断**：上游 3 分钟没进展就 `ctx.session.interrupt()`。会直接终止正在运行的
   长工具（合法任务也会被杀掉）。否决。
2. **超时检测 + 工具状态判断**：读 `ctx.session.context()`，看最后一条 assistant 消息里
   有没有 `status` 为 `running` / `streaming` 的工具 part——有就继续等，没有才放弃这一轮。
   不打断，但插件自己维护了第二份状态（进展信号 + 计时器），和上游状态重复。否决。

### 候选方案（单一状态源）

- **A. 不再恢复在途轮次，上游忙时把消息直接投进上游 inbox。** `ctx.session.prompt` 本来
  就只是入队（返回 `SessionInboxUser`），消息进上游 inbox 后由上游自己排队执行；本地只留
  还没投过 prompt 的消息。状态只以上游为准。风险：上游那次执行不结束，inbox 里的消息同样
  不会跑，但状态是干净的，TUI 里能看到。
- **B. 结束信号只认上游事件。** 删掉 `sessionRunning()` 的轮询判定，把
  `session.execution.succeeded` / `session.execution.interrupted` / `experimental.idle`
  作为唯一的轮次结束依据，watchdog 只做兜底。风险：漏掉事件就再也投不出去。
- **C. 用 `session.status` 事件代替时间戳推断。** 上游的 `session.status` 事件直接带
  `status.type`（`idle` / `retry` / `busy`），语义就是「上游此刻有没有在跑」，比
  `time.busy > time.idle` 的时间戳猜测准。状态源仍是上游。风险：`session.status` 是
  ephemeral 事件，重启后不补发，启动时还是得靠 `ctx.session.get()` 的快照兜底，而快照
  本身依旧是时间戳推断。
- **D. 把「在途轮次」和「上游在执行」拆成两件事。** 只有收到 `session.execution.started`
  才认为上游真的开了一轮；`restoreInflight()` 恢复出来的 `state.current` 不再作为「上游
  在跑」的依据，只保留「这一轮已经发过、可能已经回复过」的语义。
  `session.execution.*` 是 durable 事件，重启后仍能补收，可靠性比 ephemeral 的
  `session.status` 高。风险：`started` 只覆盖插件订阅之后发生的执行，重启前那一轮拿不到，
  仍要用 `time.busy` / `outcome` 快照补齐。
- **E. 卡住就换会话，不再等上游。** 复用已有的 `resetTarget()`（`/reset` 命令）和
  `retireSession()`（interrupt + remove + 冷却 10 分钟）；新建会话后用 `prepareTurn()` 的
  历史回补从 QQ 侧重新拉最近若干轮消息（`config.history.count`），把上下文搬到新会话，
  同时清掉 `state.historyDone` 让回补能重跑。状态源：会话绑定本身。风险：换会话会丢掉
  上游那一轮的中间状态，历史回补只覆盖最近若干轮；冷却期内同一聊天要排队。
- **F. 本地队列只负责「还没投过 prompt 的消息」。** A 的落地细则：本地队列的职责边界到
  `ctx.session.prompt` 返回为止，拿到 `SessionInboxUser` 就从本地移除，之后完全以上游
  inbox 为准。风险：插件侧看不到「还剩几条」，只能靠 `session.inbox.*` 事件和 TUI 观察；
  上游那一轮不结束，inbox 里的消息同样不跑。

### 相关代码位置

- `src/session/manager.ts`：`restoreInflight()`、`deliver()`、`sessionRunning()`、
  `upstreamRunning()`。
- `src/index.ts`：上游事件订阅、`scheduleMessage`、`handleMessage`。

## 日记总结会话长期复用，上下文只增不减

### 现象

- 每天的自动总结都复用同一个上游会话，提示词叠在旧上下文上。
- 运行足够久之后，总结请求会因超出模型上下文而持续失败。

### 现状

- 会话 ID 存在 `ctx.storage` 的 `diary-summary-session`，重启后继续复用（`src/diary/summary.ts`）。
- 目前只有单次总结的 120 秒超时，没有轮次上限，也没有按天重建。
- 2026-11-11 的审计把它列为低危，未要求本轮修复。

### 候选方案

- **A. 按天换总结会话。** 把 `ctx.storage` 的键从 `diary-summary-session` 换成带日期的键
  （如 `diary-summary-session:2026-11-11`），每天第一次总结时新建会话，昨天的会话用
  `ctx.session.remove()` 清掉。状态源：上游会话本身 + storage 里记的当前会话 ID。
  风险：每天多一个会话需要清理；跨天不再共享上下文。
- **B. 每轮结束后压缩历史。** 用 `ctx.session.compact({ sessionID })`（上游自带 compaction，
  `SessionDomain` 有 `compact`）把旧轮次压掉，保留同一个会话。状态源：上游的 compaction
  结果。风险：compact 自己要跑一次模型，多一次开销和失败点；`session.compaction.*` 事件
  要单独处理。
- **C. 给素材总量加字节上限。** 超过上限就截断或分批，避免单次提示词本身过大。
  状态源：输入素材本身。风险：截断会让总结漏掉后面的内容。
- **D. 素材分片 + 多次总结再合并。** 把一天素材按字节切成 N 片，每片单独总结，再把 N 个
  摘要合并成一篇。状态源：输入素材（分片是纯函数）。风险：模型调用次数和延迟成倍上升；
  合并那一步仍可能超上下文，还要再兜一层上限。
- **E. 改用无状态生成。** 用 `ctx.experimental.generate.text({ prompt, model })` 做总结：
  它没有会话、没有历史、没有工具，天然不累积上下文；同时也不需要「给总结会话摘工具」
  （`isSummarySession()`）和「从 session 事件里捞文本」（`buffers` / `waiters`）。
  状态源：返回值 `{ text }`。风险：没有会话就没有 `session.execution.*` 事件可订阅，超时
  只能靠请求取消；这次总结在 TUI 里看不到；输出格式要求要写进提示词。
- **F. 轮次上限兜底。** 同一个总结会话累计 N 轮后强制换新（即使还没跨天），防止同一天内
  多轮总结也把上下文撑爆。状态源：上游会话的轮次计数。风险：N 不好定，估大了照样超。

### 相关代码位置

- `src/diary/summary.ts`：`ensureSession()`、`resolveSession()`、`runOnce()`、
  `DIARY_SUMMARY_SESSION_KEY`。
- `src/diary/collector.ts`：素材收集与保留天数。

## 日记总结超时只放弃等待，不取消上游请求

### 现象

- `summarize()` 超时后当作失败，但请求还在上游跑。
- 迟到的 `session.text.ended` 可能被下一轮尝试消费，最坏情况一个聊天占住调度器约 250 秒。

### 现状

- 超时逻辑在 `src/diary/summary.ts`，只 resolve `undefined`，没有调用 `ctx.session.interrupt()`。
- 调度器仍用一把全局互斥串行处理，实例交接时旧实例的在途写入可能与新实例竞争。
- 2026-11-11 的审计把它列为低危，未要求本轮修复。

### 候选方案

- **A. 超时后真正取消上游请求。** `awaitText()` 超时 resolve 之后调
  `ctx.session.interrupt({ sessionID })`，让上游那次执行停下来；上游随后会发
  `session.execution.interrupted`（`reason` 取值见上游枚举 `user` / `shutdown` /
  `superseded` / `inactivity`，主动打断对应哪一个要实测确认）。
  状态源：上游的 interrupt 结果。风险：interrupt 打断的是整个会话的当前执行，如果总结
  会话和别的逻辑共用就会误伤；要确认 interrupt 之后上游不会再吐 `session.text.ended`。
- **B. 每次总结用独立会话 + 独立 buffer key。** 不再复用一个总结会话，每次尝试（或每个
  `chat#date`）一个会话，`buffers` / `waiters` 的 key 带上这次尝试的标识，迟到的
  `session.text.ended` 落到别的 key 上，不会被下一轮误消费。状态源：每次尝试自己的 key。
  风险：会话数量增加；失去跨轮上下文（和上一节的方案 A / F 是一致的方向）。
- **C. 按 assistantMessageID 认领文本。** `session.text.started` / `session.text.ended` 都带
  `assistantMessageID`，先记下本次尝试对应的 assistant 消息 ID，之后只认这个 ID 的结束
  事件，其余一律丢弃。状态源：上游事件里的消息 ID。风险：开始事件和 prompt 返回之间有
  竞态，认领逻辑要处理「先收到结束事件再拿到 ID」。
- **D. 调度互斥从全局锁改成按 `chat#date` 粒度。** 现在一把 `Mutex` 串行所有聊天，一个
  聊天卡住就堵住别人；改成按 `chat#date` 加锁，不同聊天可以并行。状态源：各自的上游执行
  状态。风险：并发送盘要保证同一目录下的写入不互相覆盖。
- **E. 实例交接时移交在途总结状态。** 复用 `exportHandover()` / `adoptHandover()` 的做法，
  把在途总结的 sessionID 和 buffer 一起移交，旧实例退出后不再处理这些事件。
  状态源：交接数据。风险：交接协议要加字段；旧实例已经 resolve、但上游仍在跑的那部分
  仍要单独处理。

### 相关代码位置

- `src/diary/summary.ts`：`awaitText()`、`runOnce()`、`runSummary()`、`mutex`、`buffers`、
  `waiters`。
- `src/diary/scheduler.ts`：定时 tick 与推送。
- `src/session/manager.ts`：`exportHandover()`、`adoptHandover()`。
- `src/index.ts`：`lease.handover(...)` 的实例交接点。
