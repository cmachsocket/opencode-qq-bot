# 提交审计：e2cfecb..HEAD

> 状态：审计完成。范围内 27 个提交（21 项独立改动 + 1 次合并），发现 2 个高危、3 个中危、若干低危问题。
> 修复进度：全部问题已修复并补了回归用例；文档与 `CHANGELOG.md` 已同步。

## 修复状态

| 编号   | 问题                            | 状态   |
| ------ | ------------------------------- | ------ |
| 高危 1 | 通知群名片绕过净化              | 已修复 |
| 高危 2 | 追踪容量上限与 prune 记账       | 已修复 |
| 中危 3 | `suppress` 吞掉必回意图         | 已修复 |
| 中危 4 | 分段回复与限流默认值冲突        | 已修复 |
| 中危 5 | 实时消息缺角色标记              | 已修复 |
| 低危   | `/reset`、`ownerQQ`、迁移告警等 | 已修复 |

已修复部分的落地位置：

- 高危 1：`resolveUserName()` 统一走 `sanitizeSenderName()`，通知侧 `describeNotice()` 再包一层。
- 高危 2：`record()` 先 `ensureRoom()`，写满即丢弃；`prune()` 只扣减成功删除的文件；
  追踪文件按 `0600` 写入。回归用例见 `tests/trace.test.ts`。
- 中危 3：`mergeTurns()` 只在没有必回消息时保留 `suppress`；提示词按主动 > 必回 > 不插话排序。
- 中危 4：发送前按剩余额度预检分段数，不够就改走合并转发；`SendRateLimiter.remaining()`。
- 中危 5：实时入站把 `senderRole` 传给 `formatModelMessage()`。

审计范围：`e2cfecbd2908cc2c85872532103329737429b5c8` 之后的全部提交，直到 `6ae2c2b`。
`02a672b` 是 `main` 的合并，其中 `7fc8fd5` / `be1d69e` / `ad8c42c` / `ab30194` / `8ed7af5`
与 `947b7f2` / `2362ef4` / `1f151aa` / `4235f59` / `be5428d` 内容相同，审计时按一份算。

| 提交      | 内容                                                              |
| --------- | ----------------------------------------------------------------- |
| `947b7f2` | 按 owner / 管理员 / 聊天档位分配工具，新增 `src/tools/policy.ts`  |
| `2362ef4` | QQ 与 TUI 管理命令，新增 `src/commands.ts`、`src/tui-commands.ts` |
| `1f151aa` | 模型视图里标注 owner / 管理员                                     |
| `4235f59` | 表情标注抽成共享命令                                              |
| `be5428d` | 补角色、命令与工具档文档                                          |
| `9cf2310` | 订阅通知类事件，新增 `src/events/`                                |
| `8549f41` | 补通知订阅文档                                                    |
| `93c0429` | 准入判定改成放行 / 拒绝双名单，新增 `src/access.ts`               |
| `be85474` | 按聊天覆盖唤醒与主动说话                                          |
| `5335eb9` | 按聊天覆盖 agent / 模型 / 角色设定                                |
| `a7b5fa2` | 补准入名单与聊天覆盖文档                                          |
| `a01498f` | 拆分全局配置与按聊天配置文档                                      |
| `5509070` | 启动时打印插件版本号，新增 `src/version.ts`                       |
| `385f4bb` | 刷新 AstrBot 对比状态                                             |
| `138a8c6` | 新增 proactive / wake / reply / trace / stall 配置项              |
| `3055cba` | 每分钟上限可选择等待（stall）                                     |
| `df2230d` | 唤醒判定接入全局策略与 @ 上下文                                   |
| `12f1245` | 调用链追踪，新增 `src/trace.ts`                                   |
| `feeee08` | 分段回复随机间隔，长回复改合并转发                                |
| `8c5b664` | 主动说话白名单与按聊天触发概率                                    |
| `6ae2c2b` | 刷新 AstrBot 对比状态与 CHANGELOG                                 |

变更规模：58 个文件，+5590/-572。新增 `src/access.ts`、`src/commands.ts`、`src/overrides.ts`、
`src/trace.ts`、`src/tui-commands.ts`、`src/tools/policy.ts`、`src/tools/policy-guard.ts`、
`src/events/notice.ts`、`src/events/store.ts`、`src/version.ts`。

验证基线：`tsc --noEmit` 通过，`eslint .` 无告警，`vitest run` 34 个文件 / 611 个用例全绿，
`prettier --check .` 通过。

---

## 高危

### 1. 通知事件把未净化的群名片写进系统提示词

`src/events/notice.ts:86-95` 的 `nameOf()` / `withName()` 直接返回外部提供的显示名，
`src/index.ts:519-521` 把 `nameOf` 接成 `resolveUserName(renderCtx, id)`，
而 `src/naplink/render.ts:195-209` 返回的是未经处理的群名片 / 昵称（没有 `sanitizeSenderName`）。
通知文本经 `src/index.ts:294-300` 的 `event.system.push` 进入**系统提示词**。

群友只要改自己的群名片，就能在系统提示词里写入任意文本：换行、结构标签、乃至指令，
突破 `docs/security-baseline.md:57` 已经写死的「群友文本伪造不出系统结构」这条不变量。
同一个函数对文件名（`src/events/notice.ts:105`）与灰条内容（`src/events/notice.ts:131`）
都做了 `sanitizeUntrustedText`，唯独人名漏掉；`src/naplink/history.ts:259-262` 对同一来源的名字
是净化过的，行为不一致。

影响：`events.subscribe` 包含 `notice` 时，任何群友都能往系统提示词里塞内容。

建议：`describeNotice` 内部对 `nameOf` 的结果套 `sanitizeSenderName`，或让 `src/index.ts` 传净化后的名字；
补一条群名片含换行 / `【系统】` 的回归用例（`tests/events.test.ts`）。

位置：`src/events/notice.ts:86-95`、`src/index.ts:519-521`、`src/index.ts:294-300`、`src/naplink/render.ts:195-209`

### 2. 追踪容量上限实际不生效

`src/trace.ts:129-134` 的 `record()` 顺序是 `ensureRoom()` → `write(line)`，
而 `src/trace.ts:185-190` 的 `ensureRoom()` 超限时只打一条
`"调用链追踪已写满，丢弃新的追踪记录"` 的警告，随后 `write()` 照旧落盘——什么都没丢，
提示文案与行为相反。

`src/trace.ts:147-168` 的 `prune()` 还有记账错误：保留期清理时跳过了过期文件，
但降容循环遍历的是**全部** `files`（`src/trace.ts:160`），`total -= file.size` 会把已经删掉、
且从未计入 `total` 的文件再扣一次，`this.bytes` 可能被记成负数，
`ensureRoom()` 里的 `this.bytes < this.maxBytes` 随之长期成立，清理再也不会触发。

影响：`trace.maxSizeMb`（默认 80MB）与 CHANGELOG 里「超期与超容量的旧文件会被清掉」的承诺都不成立，
追踪目录可能无限增长；追踪内容含目标 key、QQ 号与 session id，泄露面随之扩大。

建议：`ensureRoom()` 返回布尔，`record()` 在返回 false 时真正丢弃这条记录；
`prune()` 的降容循环只遍历仍在统计里的文件，或删除后重新计算 `total`。

位置：`src/trace.ts:129-134`、`src/trace.ts:147-168`、`src/trace.ts:185-198`

## 中危

### 3. 混合批次里「被 @ 必回」被「不要回复」覆盖

`src/session/manager.ts:155` 用 `some` 合并 `atMe`，`src/session/manager.ts:134` 同样用 `some` 合并
`suppress`；`src/index.ts:285-292` 组装提示词时 `suppress` 优先于 `wakeHint()`。
于是同一批消息里既有直接 @ 机器人的、又有 @ 别人的消息时，合并结果是 `atMe=true` 且 `suppress=true`，
模型被明确告知「这条消息不是在跟你说话，不要回复。」，必回意图被吞掉。

建议：`suppress` 只在 `!atMe` 时生效，或合并时让「必回」优先。

位置：`src/session/manager.ts:130-134,155,160`、`src/index.ts:285-292`

### 4. 回复分段与限流默认值互相打架

`src/config.ts:224` 的每分钟上限默认 8 条（按目标计数，`src/rate-limit.ts:40-42`），
`src/config.ts` 的 `reply.segmentChars` 默认 150、`reply.forwardThresholdChars` 默认 1500。
`src/tools/qq.ts:392-398` 按 150 字切段、每段各占一条额度（`src/tools/qq.ts:405-417`），
于是 1200~1500 字的回复会切成 9 段以上，第 9 段被限流拒绝：
`src/tools/qq.ts:409` 返回「已发送 8/9 段」的 error，用户看到半截消息，模型也会以为发送失败。
超过 1500 字的回复反而一次合并转发成功，行为不连续。

建议：把 `reply.forwardThresholdChars` 默认值压到 `maxPerMinute × segmentChars` 以内，
或在切段前按剩余额度预检段数。

位置：`src/config.ts:224`、`src/tools/qq.ts:392-398,405-417`、`src/tools/qq.ts:240-245`

### 5. 角色标记只做了一半

`src/model-view.ts:127-135` 的 `formatModelMessage` 支持 `role` 标记，`src/naplink/history.ts:88-93`
的历史回填传了 `deps.roleOf(userId)`；但 `src/index.ts:446-452` 的实时入站没有传 `role`，
`src/index.ts:429` 算出的 `senderRole` 只用于工具档位。于是当前这一轮的模型视图里没有
`(owner)` / `(admin)` 标记，只有历史消息有。README 写的「实时消息与历史回填一致」与实现不符。

建议：`src/index.ts` 入队时把 `senderRole` 一并传给 `formatModelMessage`。

位置：`src/index.ts:429,446-452`、`src/naplink/history.ts:88-93`、`src/model-view.ts:127-135`

## 低危 / 提示

- **`/reset` 可重置任意群号**：`src/commands.ts:162-165` 用 `parseChatArg`（`src/commands.ts:54`）解析出
  目标后直接 `manager.resetTarget`，不校验准入名单；管理员可以清掉未授权群的会话状态，
  并在 `/reset` 列表里留下非准入目标的状态条目。TUI 的 `/qq-reset` 同理。
  建议：`resetTarget` 前加 `isTargetAllowed` 校验。
- **`ownerQQ` 接受布尔值**：`src/config.ts:440-451` 用 `Number(value)`，`Number(true) === 1`，
  `"ownerQQ": true` 会被当成 QQ 号 1 接受。建议只接受正整数的字符串或数字。
- **迁移期静默失联**：旧的 `QQ_TARGET_GROUPS` / `QQ_TARGET_USERS` 只告警不生效，
  未迁移的升级用户会遇到「插件谁都不回」，只有日志里一条告警。
  建议把迁移提示升级为启动时的醒目警告。
- **唤醒判定里 @ 他人优先于全局前缀**：`src/overrides.ts:261` 的 `ignoreAtOthers` 抑制判定排在
  `src/overrides.ts:270` 的前缀判定之前，「@某人 /ping」不会触发。`docs/configuration.md`
  记录的顺序与实现一致，属行为意外，建议在文档里补一个例子。
- **会话覆盖为 `prefix` 时会跳过后续判定**：`src/overrides.ts` 里 `wake === "prefix"` 分支提前返回，
  该群不再检查 `replyToSelf`、`at_all` 与全局前缀。
- **子代理会话绕过工具档**：`src/tools/policy-guard.ts` 只在 `manager.activeTurn(sessionID)` 存在时拦截，
  子代理的 session id 与主会话不同，`src/index.ts:302-307` 的上下文删工具同样跳过，
  两层限制都不生效。目前被默认 `chat` 档拒绝 `task` 工具挡住，自定义档一旦放行即可绕过。
  建议：显式拒绝在 QQ 绑定的会话里创建子代理。
- **管理员未进放行名单就联系不上**：`src/access.ts` 的 `isTargetAllowed` 只豁免 owner 的私聊，
  不在 `access.allow.users` 里的管理员连私聊都会被拒，`src/commands.ts:14` 的 `isCommandChat`
  因此永远不成立。README 写的「管理员拥有全部工具权限」没写清这个前提。
- **群级指定档对管理员无效**：`src/tools/policy.ts:145` 的 `profileNameFor` 对 owner / 管理员
  直接取 `admin` 档，忽略 `chats[chatKey]`。
- **主动说话的轮次按普通成员执行**：`src/session/manager.ts` 的主动消息与空闲提醒都不带 `role`，
  `activeTurn` 取到的是 `member`，主动说话时工具权限最低。
- **追踪文件权限偏宽**：`src/trace.ts:194` 的 `mkdir` 里的 `0o700` 只在目录新建时生效，
  `src/trace.ts:196` 的 `appendFile` 用默认 umask（通常 0644）。同项目的
  `src/naplink/media.ts:202` 已按 `0o600` 写文件，这里没对齐。
- **未知配置项的作用域漏了 `access`**：`docs/configuration.md:24` 列出的作用域里没有 `access`，
  但代码确实会报告 `access.*` 下的未知键。
- **`ownerQQ` 的文档描述与实现不符**：`docs/configuration.md:258` 写「自动加入 `users`」，
  代码只豁免拒绝名单并单独放行 owner 的私聊，并没有把 owner 写进放行名单。

## 核对通过的部分

- **准入判定顺序与文档一致**：`src/access.ts` 的 `isTargetAllowed` 按「owner 私聊 → 拒绝名单 →
  放行名单 → 空名单时的 `allowAllWhenEmpty`」判定，README「准入判定」一节描述一致；
  owner 出现在拒绝名单里会被豁免并告警。
- **配置解析的两层合并是安全的**：`src/config.ts` 的 `resolveConfig` 先用 `DEFAULT_CONFIG` 解析环境变量，
  再以解析结果为默认值解析插件选项；`access` 的默认值永远完整，
  用户只写 `access.allow.groups` 时其余字段回落到环境变量层，不会出现 `[...undefined]`。
- **工具档解析稳妥**：`src/tools/policy.ts` 的 `parseToolPolicy` 合并缺失的档位、
  对写错的结构告警并回落默认值；`ToolPolicy` 按 mtime 热加载，解析失败沿用上一份。
  `allowedTools` 里拒绝优先、放行 `*` 表示全部。
- **按发送者角色放开本地工具是既定语义**：`docs/configuration.md:253` 写明
  「工具按『发送者角色 + 聊天』分配」，`docs/configuration.md:264` 的表里 owner / 管理员都用
  `admin` 档（`allow: ["*"]`）。`src/tools/policy.ts:10` 的 `roleOf()` 按消息发送者判角色、
  `src/session/manager.ts:140-146` 在同一批消息里取最低角色，与文档一致，不作问题记录。
- **限流 stall 窗口的等待量计算正确**：`src/rate-limit.ts` 等到窗口内第
  `minute.length - (maxPerMinute - 1)` 旧的那条记录滑出，等待时长封顶 `stallMaxWaitMs`，
  且全程持有该目标的互斥锁。
- **命令通道的收窄是对的**：`src/commands.ts:14` 要求私聊、发送者等于目标 id、且发送者是 owner 或管理员；
  TUI 侧命令统一加 `qq-` 前缀（`src/tui-commands.ts`）。
- **通知缓存本身没有并发问题**：`src/events/store.ts` 每个目标最多 20 条、30 分钟过期，
  `take()` 取走即清空，通知不会自己起一轮。
- **示例文件不含真实信息**：`chat-overrides.example.json`、`tool-profiles.example.json`、
  `opencode.example.json` 里的群号与 QQ 号都是占位值；`.gitignore` 已忽略 `.env*`、
  `opencode.json`、`tool-profiles.json`、`chat-overrides.json`。

---

## 与其它审计的关系

- 本文件高危 1（通知里的群名片绕过净化）与 [commit-audit-7a3a106.md](./commit-audit-7a3a106.md)、
  [commit-audit-c90b2bc.md](./commit-audit-c90b2bc.md) 的入站净化缺口同属一处边界，
  修复时应收敛到同一个净化入口。
- 本文件高危 2（追踪容量上限不生效）与 [commit-audit-9699c96.md](./commit-audit-9699c96.md)
  的日志保留策略是同一类问题：上限只是写在配置和文档里，没有真正落到代码上。

## 建议修复顺序

1. 高危 1：通知里的群名片进系统提示词
2. 高危 2：追踪容量上限与 prune 记账
3. 中危 4：回复分段与限流默认值
4. 中危 3、5：唤醒合并、角色标记
5. 低危项与文档修订

涉及行为的修复需补回归用例，用例放在 `tests/` 下。
