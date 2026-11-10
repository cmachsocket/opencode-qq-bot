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

### 相关代码位置

- `src/session/manager.ts`：`restoreInflight()`、`deliver()`、`sessionRunning()`、
  `upstreamRunning()`。
- `src/index.ts`：上游事件订阅、`scheduleMessage`、`handleMessage`。
