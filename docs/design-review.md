# 设计审查

> 状态：核心 P0/P1 问题已修复并补充测试；图片内联相关项按要求暂缓，许可证条目保留。

审查范围：`src/` 下的配置、消息渲染、会话管理、QQ 工具与插件入口。审查时 `typecheck`、`lint`、81 个测试均通过，但异常路径、并发控制与信任边界存在设计缺陷；修复后测试增至 108 个。

## P0：会导致卡死、并发错乱或安全问题

### 1. busy 状态在模型失败/中断后无法恢复

`handleIdle` 只在正常空闲时触发，`session.idle` 也不会在失败、中断时出现。`flushBuffered` 在 buffer 为空时直接返回，不会清除 `busy`；`busyTimeoutMs` 只在下一条消息入队时检查，群安静时永远不恢复。

建议订阅 `session.execution.failed/interrupted` 和 `session.status`，或在 `handleIdle`/flush 中无条件校验并清理超时状态；引入显式状态机（idle / dispatching / waiting / failed）。

位置：`src/session/manager.ts:225-279`，`src/index.ts:57-74`

### 2. 后台任务判断范围错误

使用 `event.background.length` 会把子会话遗留的任务也算作本会话忙碌，而这类任务完成后未必再唤醒父会话，导致群永久 busy 到超时。

应只检查 `background.some((b) => b.sessionID === event.sessionID)`。

位置：`src/index.ts:58`，`src/session/manager.ts:225-232`

### 3. proactive 与用户消息存在竞态，`ensureSession` 无 single-flight

`proactive()` 先查 `busy`，再 `await ensureSession()`，之后才置 `busy`；期间用户消息可正常 dispatch，形成两个并发 prompt。并发 `ensureSession` 可能为同一群创建两个会话；`bindSession` 直接覆盖 `state.sessionID`，旧会话仍留在 map 中，破坏一对一绑定。`setInterval` 的 tick 也可能重叠。

建议所有 dispatch 入口串行化；`ensureSession` 用 in-flight Promise 去重；绑定写入做冲突检测而非覆盖。

位置：`src/session/manager.ts:282-324, 347-357`，`src/index.ts:112-129`

### 4. 入站消息顺序无保证

每条事件用 `void handleMessage(event)` 并发处理；图片下载、成员查询、语音转写耗时不同，早到的消息可能晚入队，`touch` 时间也会失真。

建议按 groupId 建 FIFO 队列，渲染完成后再入队；或把“渲染 + 入队”整体串行化。

位置：`src/index.ts:76-105`

### 5. 工具权限过大，且信任边界不清

群消息原文直接进入 prompt，模型可被注入诱导调用：

- `qq_send_image` / `qq_send_record` 接受任意本地路径或 URL（文件外泄、SSRF）；
- `qq_delete_message` 可删除任意 message_id；
- `qq_fetch_ptt_text` 不校验群绑定。

鉴权只依赖 `groupForSession`，即使群已从 `config.groups` 移除，旧绑定仍可用；用户在 UI 中直接对绑定会话发 prompt 也会获得 QQ 工具。

建议工具内校验 `config.groups` 与来源会话；限制媒体路径到白名单目录或仅允许入站附件；删除操作校验消息归属；对工具参数做 schema 约束。

位置：`src/tools/qq.ts:60-63, 122-165, 230-292`，`src/index.ts:45-54`

### 6. 图片限制不一致，存在内存与网络风险

`base64://` 一律标记为 `image/png`，不做魔数嗅探、不限制 5MB；`data:` 直接透传、无上限；5MB 限制只作用于 HTTP。fetch 无超时、无重定向限制，可被慢响应或内网地址拖住。

建议统一走“读取上限 + 魔数识别 + 超时/中止 + 协议/主机校验”。

位置：`src/naplink/render.ts:206-236`

### 7. buffer 无上限

busy 期间每条 Turn（含最大 16MB 的 data URL）全部保留，无条数/字节上限、无丢弃策略、无持久化；卡死时可能 OOM。`mergeTurns` 只在 flush 时裁剪。

建议设置每群 buffer 上限与总字节预算，超限丢弃最旧或拒绝并告警。

位置：`src/session/manager.ts:162-181, 37-46`，`src/naplink/render.ts:8-13`

## P1：行为正确性与可运维性

### 8. `qq_send_message` 按行拆分发送

每个非空行单独发一条 QQ 消息，且每行后都 `Bun.sleep`（包括最后一行），破坏空行与排版，易触发风控，工具调用被 N×delay 阻塞。部分失败时前面的行已发出，但 `markMessageSent` 未调用，随后触发“未发送”提醒。长度警告按总长度而非单条消息；超长单行仍可能超平台限制。

建议整段发送或按平台长度上限分段；失败时记录已发送部分；去掉末行 sleep。

位置：`src/tools/qq.ts:104-118`

### 9. 发送记账不一致

只有 `qq_send_message` 会 `markMessageSent`；图片、语音、转发、戳一戳同样是对外回复，却仍会触发提醒并保持 `awaitingSend`。schema 要求 `content` 必填，与 prompt 中“reply=false 时 content 留空”矛盾，模型只能传占位内容。

建议统一“任何发送类工具成功即标记已回复”；`content` 在 `reply=false` 时改为可选。

位置：`src/tools/qq.ts:72-85, 122-228`，`src/session/prompt.ts:13`

### 10. proactive 语义与实现不一致

- 重启后 `lastUserMessageAt` 初始化为 `Date.now()`，静默计时被重置。
- 每个 tick 都按 `probabilityPerHour` 抽一次，实际频率随 `tickSeconds` 放大，并非“每小时概率”。
- 多个数值未做范围校验；proactive 后不重置静默时间；无绑定群无法首次主动发言。
- proactive 时 `atMe=false`，context 提示“可以不回复”，与 `PROACTIVE_HINT` 的“必须发言”冲突。

位置：`src/session/manager.ts:124, 150-157, 354`，`src/index.ts:112-125`，`src/session/prompt.ts:18-23`

### 11. 陈旧绑定无恢复机制

恢复的 session ID 从不校验；会话被删除后每次 prompt 都失败，也不会重建。`findExistingSession` 只查前 100 条，无分页/最近优先。cleanup 时 `scheduleSave` 未 await，最后一次绑定可能丢失。

建议首次使用时 `session.get` 校验，失败则解绑并重建；保存改为可 await 的 flush。

位置：`src/session/manager.ts:77-95, 282-310, 327-339`，`src/index.ts` cleanup

### 12. 配置校验缺口

- 未知选项被 `z.object` 静默剥离，与“配置错误会告警”的预期不符。
- `groups` 中非法项被静默丢弃，无去重、无格式范围检查。
- 多个数值允许 0/负数/越界（`sendDelayMs`、`warnLength`、`busyTimeoutMs`、`reminder.max`、概率、静默阈值）。
- URL 缺失时先抛错，已收集的 warning 全部丢失。
- `DEFAULT_CONFIG` 的嵌套引用可能被调用方修改。

位置：`src/config.ts:114-131, 152-170, 232-256, 326-334`

### 13. 渲染健壮性

- `shouldProcess` 忽略仅 @、face、reply 的消息，@bot 只发表情时会被丢弃。
- 单个 segment 数据异常可能丢弃整条消息；引用只保留文本，丢失图片/语音。
- 多条 record 共用 `event.message_id` 转写；无 sender 的转发节点被静默丢弃。
- 嵌套转发按“每层 50 节点 × 深度 3”调用 API，无全局预算；截断可能切断代理对或 HTML。
- `resolveUserName` 每条消息都请求群成员信息，无缓存。

位置：`src/naplink/render.ts:46-59, 238-250, 342-373, 405-455`

### 14. 事件订阅无自愈

`session.idle` 的异步循环一旦异常退出就永久停止，之后 buffer 不再 flush。

建议加重启/退避，或改为每次事件独立处理并记录错误。

位置：`src/index.ts:62-74`

## P2：工程与结构

### 15. 可复现性

- 所有依赖写 `"latest"`，构建不可复现。
- `exports` 直接指向 `./src/index.ts`，无 `main`/`types`/构建产物，消费方需自行转译 TS。
- `peerDependencies.typescript` 对运行时插件意义不大。
- `Bun.sleep` 绑定 Bun 运行时。
- 代码使用 CC-BY-NC-SA-4.0，作为库分发可能限制商用。

位置：`package.json`，`src/tools/qq.ts:113`

### 16. 职责过载

`SessionManager` 同时承担绑定存储、消息队列、busy 状态、提醒、proactive。`GroupState` 多个可变布尔标志之间没有不变量约束，建议改为显式状态联合类型 + reducer。

`index.ts` 混合编排、订阅和定时器；`render.ts` 502 行混合下载、MIME、渲染、成员查询、转发；`tools/qq.ts` 大量重复样板。建议拆分：BindingStore、TurnQueue、ProactiveScheduler、MediaResolver、QQToolFactory。

### 17. 测试覆盖偏 happy path

缺少：入站顺序、失败/中断恢复、proactive 竞态、未知配置键、base64 大小/MIME、并发 enqueue、存储失败、陈旧绑定、媒体工具记账、cleanup flush。现有 81 个测试全部通过，但上述路径基本未覆盖。

## 文档与实现不一致

- README 称 `warnLength` 按单条消息，代码按总长度。
- README 称 `reply=false` 时 `content` 可空，schema 实际必填。
- README 称单图 5MB，`base64://` 与 `data:` 绕过。
- README 称每轮必须调用 `qq_send_message`，但媒体工具也是发送动作。
- README 称重启复用绑定，但无陈旧会话恢复。
- README 称群静默后主动发言，实际静默计时在启动时重置。

## 建议修复顺序

1. 状态机与异常恢复（P0-1、P0-2、P1-14）
2. 并发串行化与 `ensureSession` 去重（P0-3、P0-4）
3. 工具鉴权与媒体输入约束（P0-5、P0-6）
4. buffer 限额与发送记账（P0-7、P1-8、P1-9）
5. 绑定恢复、配置校验、proactive 语义（P1-10 至 P1-12）
6. 渲染健壮性与结构拆分（P1-13、P2-16）
7. 锁定依赖版本并补齐异常路径测试（P2-15、P2-17）
