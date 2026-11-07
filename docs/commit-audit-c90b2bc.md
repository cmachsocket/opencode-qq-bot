# 提交审计：c90b2bc..HEAD

> 状态：审计完成，问题已修复（3 个高危、3 个中危全部处理）。范围内 8 个提交，发现 3 个高危、3 个中危问题。

审计范围：`c90b2bcf0dc803643eaae969a57d22b2ee305bac` 之后的全部提交。

| 提交      | 内容                                                              |
| --------- | ----------------------------------------------------------------- |
| `049fd47` | 刷新配置文档，`warnLength` 20→500，导出 `ENV_VARS`                |
| `e3eea2e` | 新增 `docs/comparison-qq-bridge.md`                               |
| `f15cec8` | 对比文档补充 A4 的 OpenCode 平台落点                              |
| `4efe8be` | 新增 `src/keepalive.ts`（保活心跳）                               |
| `bebfb97` | `render.ts` 修复表情 / @ 消息被丢弃                               |
| `510d417` | 新增 `src/outbound.ts`（markdown 剥离 + 字素簇切分），新增 NOTICE |
| `b180063` | 新增 `src/naplink/history.ts`（冷启动历史回填）                   |
| `4fba751` | 新增 `src/model-view.ts`（入站净化 + 绝对时间戳）                 |

验证基线：`tsc --noEmit` 通过，`eslint .` 无告警，`vitest run` 18 个文件 / 295 个用例全绿。
上游核对：OpenCode `dev` 分支 `packages/core/src/location-activity.ts`、`location-lifecycle.ts`、
`bus.ts`、`plugin/host.ts`、`packages/server/src/handlers/session.ts`、
`@opencode/schema/dist/session-event.d.ts`；NapCat 侧核对 `NapCatQQ#987`、`#441`、`PR #944`
与 `packages/napcat-core/apis/msg.ts`。

---

## 高危

### 1. 入站净化逐段执行，结构标签可跨段拼接伪造

`src/naplink/render.ts:389` 对每个消息段单独调用 `sanitizeUntrustedText(segment.data.text)`，
最后在 `src/naplink/render.ts:473` 拼接；`src/model-view.ts:24-31` 的净化是整体正则替换，
`<` 与 `quote>` 分处两段时匹配不到，标签原样进入提示词。

实测：

```
sanitizeUntrustedText("<") + sanitizeUntrustedText("quote>") === "<quote>"   // 未被中和
sanitizeUntrustedText("<quote>") === "＜quote＞"                          // 整体净化才有效
```

路径：`render.ts:389` → `render.ts:473` → `src/index.ts:203-216`
（`formatModelMessage` 不再二次净化正文）→ `manager.enqueue` → 提示词。
QQ 一条消息可携带多个 text 段，群友把 `<quote>` / `<forward>` / `<history>` 拆成两段即可伪造
本插件的结构块。同一逐段模式还出现在 `render.ts:195`（合并转发）、`render.ts:221`、
`render.ts:449`（文件名）、`render.ts:422`（语音转写）。

连带失真的文档：`src/model-view.ts:21-22`、CHANGELOG `[Unreleased] Added` 的入站净化条目、
README 入站净化段、`docs/comparison-qq-bridge.md` 的 A3 表。

建议：整条消息渲染完成后再对拼接结果做一次整体净化（`render.ts:473` 之后），
或改为对整条消息文本净化；补一条“两段拼成 `<quote>`”的回归用例。

位置：`src/naplink/render.ts:389,473`，`src/model-view.ts:9,24-31`

### 2. 历史补页缺少 `reverse_order`，冷启动增量退化为最近 N 条重复注入

`src/naplink/history.ts` 的 `requestHistory` 调 `getGroupMsgHistory` / `getFriendMsgHistory`
只传 `{group_id|user_id, message_seq, count}`，从不传 `reverse_order`
（SDK 支持该参数：`node_modules/@naplink/naplink/dist/index.d.ts:555,561,939,945`）。

NapCat 语义（`#987` 结论）：`reverse_order` 不传或传 `false` 取“目标 seq 往**当前时间**的 count 条
（含 seq 本身）”，传 `true` 才是“往**更早**的时间”；`#441` 与 `PR #944` 证实提供 `message_seq`
后方向由该参数决定。

因此 `fetchGap` 的分页逻辑失效：

1. 游标取 `oldest.message_id` 再请求，拿到的是更新的消息而非更早的，`seen` 去重后 `added` 恒为 0，
   `reached` 永远为 `false`；
2. 退回时间分支，`findIndex(entry.time > since.time)` 在只有最新消息的页面上返回 0，
   取回的是最近 N 条，而不是缺失的那段增量；
3. 这批消息在上一轮运行中已投递过，而 `exclude` 只记录本轮的 `incoming`
   （`src/index.ts:244` → `manager.rememberIncoming`，每轮重置），于是被再次注入上下文。

即 CHANGELOG 中“冷启动补历史 / 重启后恢复会话时补增量”在重启场景下会重复灌入最近消息。
`tests/history.test.ts` 只断言了 `message_seq: "0"`（`fetchLatest`），`fetchGap` 的方向无覆盖。

建议：`requestHistory` 增加 `reverse_order` 参数，`fetchGap` 传 `true`、`fetchLatest` 传 `false`，
并补一条断言请求参数的单测。

位置：`src/naplink/history.ts:130-176`（`fetchGap`）、`src/naplink/history.ts` 的 `requestHistory`

### 3. NOTICE 依赖清单缺项，许可文本位置说明不实

`NOTICE:4` 称“各自的完整许可文本随依赖一起提供（`node_modules/<包名>/LICENSE`）”，实际：

- `node_modules/@opencode/plugin`、`node_modules/@opencode/schema` 没有 LICENSE 文件
  （只有 `dist/` 与 `package.json`，两者 `package.json` 标 `"license": "MIT"`）；
- `@opencode/schema` 整个不在 NOTICE 的依赖表里，而它是 `package.json` 的直接依赖（`2.2.5`）。

其余直接依赖（`@bybrave/proper-lockfile2`、`@naplink/naplink`、`async-mutex`、`remove-markdown`、
`zod`）确实自带 LICENSE 且为 MIT。

位置：`NOTICE:4`、`package.json`

---

## 中危

### 4. 删表格时把后续含竖线的正文整段吞掉

`src/outbound.ts:41` 的 `while (index < lines.length && (lines[index] ?? "").includes("|")) index += 1`
把下一行只要含 `|` 就当作表格行继续吞。实测：

```
toPlainText("| a | b |\n|---|---|\n| 1 | 2 |\n普通 | 行") === ""   // 整条消息消失
```

表格后的正常正文被无声删除，表现为“模型发了消息但 QQ 什么都没收到”。

建议：仅当行首行尾含 `|` 且列数与表头一致时才视为表格行。

位置：`src/outbound.ts:39-41`

### 5. `splitMessage` 丢失首部空行，与注释承诺不符

`src/outbound.ts:81/83` 用 `currentLength > 0 ? 1 : 0` 计算换行占位，空行长度为 0，
开头空行既不计入长度也在拼接时被吞。实测：

```
splitMessage("\n\nfoo")    === ["foo"]
splitMessage("\nfoo")      === ["foo"]
splitMessage("\n\na\n\nb") === ["a\n\nb"]   // 中部空行保留
```

`src/outbound.ts:70` 的注释“保留原有换行与空行”不成立（中部空行确实保留，仅首部丢失）。
现有测试 `tests/outbound.test.ts:98` 只覆盖中部空行。

位置：`src/outbound.ts:70,81,83`

### 6. `history.count` 未登记到配置参考

`b180063` 把 `history.count`（默认 20、`QQ_HISTORY_COUNT`、0 为关闭）写进了 `.env.example`、
README、CHANGELOG，但 `docs/configuration.md` 的“数值范围”表（`docs/configuration.md:20-29`）
与“未知配置项”白名单（第 15 行只列 `napcat` / `proactive` / `reminder` / `keepAlive`）都没有
`history`；该文档全文检索不到 `history`。同批的 `keepAlive` 已在该文档登记
（`docs/configuration.md:29,46-58`），`history` 属于漏登。

位置：`docs/configuration.md:15,20-29`

---

## 低危 / 提示

- **正文未被二次净化**：`src/model-view.ts:72-77` 的 `formatModelMessage` 只净化显示名，
  正文净化只发生在 `render.ts` 的逐段调用里，这是问题 1 的根因；`userId` 原样拼接进提示词
  （`src/model-view.ts:76`），当前来源是 QQ 数字 ID，风险低。
- **无时间戳的历史条目没有时间前缀**：`src/naplink/history.ts:88` 传 `time: entry.time ?? 0`，
  `formatTimestamp` 对 `<= 0` 返回空串（`src/model-view.ts:55`），条目格式与带时间戳的不一致。
- **`historyDone` 在取历史之前置位**：`src/session/manager.ts:492` 先置 `true` 再 await
  `ensureSession` 与取历史，一次失败（`src/session/manager.ts:510-513` 捕获）后该目标本轮
  永久不再回填历史。
- **`restoredPositions` 语义被就地改写**：`src/session/manager.ts:540` 派发成功后会更新它，
  而它是启动时快照（`src/session/manager.ts:205-222`），`prepareTurn` 的 `since` 取值语义
  因此与注释不符（当前因 `historyDone` 只跑一次，暂未暴露）。
- **`warnLength` 口径不一致**：`src/tools/qq.ts:201-203` 用 `plain.length`（UTF-16 码元）告警，
  而切分按字素簇（`src/outbound.ts:19`），一个 emoji 记 2 个码元，阈值实际偏严。
- **保活会为每个项目目录留下一个“QQ 保活”会话**：`src/keepalive.ts:129-150` 按
  `ctx.location.directory` 过滤，每个项目各建一个且不清理，用户会话列表里会出现多个同标题会话。
  已修：插件卸载时删掉保活会话（`ctx.session.remove`）并清掉存储里的记录；
  取得会话时会请求归档，让它不出现在会话列表里（上游插件接口目前忽略 `archived`，
  生效之前它仍会显示在列表中，插件会在日志里说明）；存储是机器级共享的，
  读回的会话会核对目录，不复用别的项目留下的会话。
- **对比文档数据轻微过期**：`docs/comparison-qq-bridge.md` 称 `src/` 约 5.4k 行，实际 5136 行；
  remove-markdown 的 npm 月下载写“约 513 万”，当前为 5,371,832。

---

## 核对通过的部分

- **保活前提成立**：`session.update` → `session.setMetadata` 发布 `session.metadata.updated`
  （durable 且带 `location`）→ `location-activity.ts` 的监听器 `isSessionEvent(event) && event.location`
  命中并 `touch(location)`；插件创建的保活会话继承插件 location
  （`packages/core/src/plugin/host.ts` 的 `Location.Ref.make`），`bus.makePayload` 会挂上 location。
  `opencode.example.json` 中 `experimental.location_idle_timeout: false` 符合 schema
  （`@opencode/schema/dist/config/experimental.js:40`）；`keepAlive.seconds` 默认 1200s
  小于上游默认 3600s。
- **归档只对 HTTP 接口有效**：上游 `packages/server/src/handlers/session.ts` 的 `session.update`
  有 `archived` 分支，插件走的 `packages/core/src/plugin/host.ts` 只处理 title / metadata /
  permissions，`archived` 会被忽略；SDK 类型（`SessionUpdateInput`）却带着该字段。
  所以插件只能"请求归档"，能否生效取决于上游，插件会读一次会话确认并在日志里说明。
- **对比文档 A1 / A2 / A4 / A5 / A6 属实**：无出站限速（仅 `sendDelayMs`）、无出站脱敏、
  A4 的平台落点（`ctx.tool.transform` / `ctx.permission.hook("evaluate")`）与上游 API 一致、
  `isPrivateHost` 无 DNS 解析且漏掉 CGNAT / 198.18 / IPv4-mapped / NAT64 且无端口白名单、
  `qq_send_image` 与 `qq_send_record` 直传 `file` 无目录白名单。A3 因问题 1 不成立。
- **其余提交无回归**：`RENDERABLE_SEGMENT_TYPES`（`src/naplink/render.ts:77-91`）与渲染分支一致；
  `mergeTurns` 按 `source.id` 去重、`drain` 先重试 pending 再 `prepareTurn` 的顺序正确；
  时间戳用 `sv-SE` + `hour12:false` 实测 `hourCycle=h23`，午夜输出 `26-11-07 00:30`，
  无 “24:xx” 问题；`tests/docs.test.ts` 能守住 `.env.example` / README 与 `ENV_VARS` 的一致性。
- **remove-markdown 选型核对通过**：0.8.0 发布于 2026-10-04、MIT、379 star / 74 fork、
  约 197 次提交；markdown 表格与 `2 * 3 * 4 = 24` 不被剥离。

---

## 建议修复顺序

1. 问题 1（提示词注入面）
2. 问题 2（上下文重复注入）
3. 问题 3（许可合规）
4. 问题 4 / 5（出站丢内容）
5. 问题 6（文档补登）

问题 1、2、3 需补回归用例，用例放在 `tests/` 下。
