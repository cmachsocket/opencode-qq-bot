# 能力对比条目状态总览

> 用途：`docs/comparison-qq-bridge.md` 与 `docs/comparison-astrbot.md` 保留为**评审记录**（为什么提、
> 参照项目怎么做的）；这份文档是它们的**状态索引**，只回答「现在是什么状态、落在哪、配置面是什么」。
>
> 尚未实现的条目 = 早期阶段的待办，不等于缺陷。
> 属于 OpenCode 职责的能力（模型上下文、记忆与检索、沙箱、token 成本）不在本文档的清单里。

## 一、状态口径

| 状态         | 含义                                 |
| ------------ | ------------------------------------ |
| **已实现**   | 代码与测试都已落地，配置项可用       |
| **部分实现** | 覆盖了条目的一部分语义，剩余部分单列 |
| **待实现**   | 已采纳、方案清楚，尚未动工           |
| **待评审**   | 是否要做、做到什么程度还没定         |
| **待商讨**   | 依赖其它结论，方案本身未定           |
| **已修复**   | 已确认缺陷，修复完成                 |

---

## 二、与 qq-bridge 对比的 19 条候选 + 1 个缺陷

| #   | 条目                     | 状态       | 落点                                                                                                   | 备注                                                                                                    |
| --- | ------------------------ | ---------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| A1  | 出站发送速率限制         | **已实现** | `src/rate-limit.ts`、`src/tools/send-guard.ts`、`tests/rate-limit.test.ts`、`tests/send-guard.test.ts` | 按目标计数；硬上限超出即拒绝，插件自身消息走 `pace()` 只等不拒；同一次工具调用拆出的多段共用配额        |
| A2  | 出站敏感信息拦截         | **已实现** | `src/sensitive.ts`、`tests/sensitive.test.ts`                                                          | 基于 `flare-redact`；额外覆盖环境变量里的密钥值、NapCat token、凭证路径、base64 解码后复扫              |
| A3  | 群消息注入净化           | **已实现** | `src/model-view.ts`、`tests/model-view.test.ts`                                                        | 结构标签折平、零宽字符清零、按消息 ID 去重；时间戳用绝对时间                                            |
| A4  | QQ 会话的工具面处置      | **已实现** | `src/tools/policy.ts`、`src/tools/policy-guard.ts`、`tests/policy.test.ts`                             | 按「发送者角色 + 聊天」分配工具：owner 与管理员全开，其他人按配置档白名单；上下文删一次、执行前再挡一次 |
| A5  | SSRF 防护                | **已实现** | `src/safe-fetch.ts`、`tests/safe-fetch.test.ts`                                                        | 连接层校验，端口白名单 `[80, 443, 8080, 8443]`，3xx 直接失败不跟随跳转                                  |
| A6  | 媒体路径白名单           | **已实现** | `src/media-path.ts`、`tests/media-path.test.ts`                                                        | `allowedDirs` 词法 + realpath 双重判定；**空名单 = 本地文件全部拒绝**，远程 URL 走 A5                   |
| B1  | 冷启动补历史             | **已实现** | `src/naplink/history.ts`、`tests/history.test.ts`                                                      | 新建会话时一次性补齐最近 N 条；是补齐，不是落库，不新增工具面                                           |
| B2  | 分对象的记忆存储         | **待商讨** | —                                                                                                      | 优先级低（已有 opencode-mem 时收益有限）                                                                |
| B3  | QQ 侧管理命令            | **已实现** | `src/commands.ts`、`src/tui-commands.ts`、`tests/commands.test.ts`                                     | QQ 与 TUI 共用一张命令表；QQ 侧只在 owner 与管理员自己的私聊生效                                        |
| B4  | 会话重置 / 退役          | **已实现** | `src/session/manager.ts`（`resetTarget`）、`tests/manager.test.ts`                                     | `/reset <目标>` 先打断执行中的回合再删会话，下一条消息重开并补历史                                      |
| B5  | 出站文本质量             | **已实现** | `src/outbound.ts`、`tests/outbound.test.ts`                                                            | `remove-markdown` + `Intl.Segmenter` 字素簇切分；只作用于模型产出文本                                   |
| B6  | 失败兜底文案             | **已实现** | `src/session/manager.ts`（`notifyFailure`）、`tests/manager.test.ts`                                   | 固定文案 + 每目标冷却，连续失败只提示一次；上游异常原文只进日志                                         |
| B7  | 通知事件订阅             | **已实现** | `src/events/notice.ts`、`src/events/store.ts`、`tests/events.test.ts`                                  | 可配置订阅类别与通知类型；只记日志并注入上下文，不自己起一轮；默认只订阅消息类                          |
| C1  | 持续集成                 | **已实现** | `.github/workflows/ci.yml`                                                                             | 隐私扫描 → 冻结安装 → `tsc --noEmit` → `eslint .` → `prettier --check .` → `vitest run` → `bun audit`   |
| C2  | 隐私扫描                 | **已实现** | CI 阶段、`scripts/trufflehog.yml`                                                                      | 扫工作树与 git 历史：QQ 号、凭证赋值、PEM、绝对路径                                                     |
| C3  | 安全基线与漏洞报告       | **已实现** | `SECURITY.md`、`docs/security-baseline.md`、`NOTICE`                                                   | 信任边界、数据流、不变量清单，每条带实现与测试落点                                                      |
| C4  | 发布流程                 | **已实现** | `.github/workflows/release.yml`、`scripts/release-check.ts`、`docs/release.md`                         | tag `v*` 触发；先跑完整门禁，再暂存发布并建 GitHub Release                                              |
| C5  | 日志文件与脱敏           | **已实现** | `src/logger.ts`、`tests/logger.test.ts`                                                                | `winston` + `winston-daily-rotate-file`，文件轮转 + 出站脱敏                                            |
| C6  | 配置面扩展               | **已实现** | `src/access.ts`、`src/overrides.ts`、`src/session/soul.ts`、`src/session/manager.ts`                   | allow / deny 双列表与 owner 豁免；每会话覆盖唤醒、主动说话、agent、模型与角色设定                       |
| D1  | 只含 QQ 表情的消息被丢弃 | **已修复** | `src/naplink/render.ts`、`tests/render.test.ts`                                                        | 门卫改按可渲染段类型放行，与渲染分支一一对应                                                            |

---

## 三、与 AstrBot 对比的 10 条增量

AstrBot 自己充当 agent runtime（44 个 provider、工具循环、OS 沙箱、向量库 + BM25、上下文压缩、面板）。
它的多数能力属于 OpenCode 职责，因此这里只列**落在 QQ 生命周期管理上**的增量。

| #   | 条目                | 状态         | 落点                                           | 备注                                                                            |
| --- | ------------------- | ------------ | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| A1  | 限流缺 `stall` 一档 | **已实现**   | `src/rate-limit.ts`                            | `rateLimit.stall` 只让每分钟窗口睡到窗口结束再发，每小时上限仍然直接拒绝        |
| A2  | 唤醒判定过简        | **已实现**   | `src/overrides.ts`、`src/naplink/render.ts`    | 全局 `wake.*` 策略 + 每会话覆盖；忽略 @all、群内首段 @别人不唤醒、回复自己必回  |
| A3  | 白名单只有 allow    | **部分实现** | `src/access.ts`                                | 已有 allow / deny 双列表与 owner / 管理员角色；群管理员分级未做                 |
| B1  | 分段回复节奏固定    | **已实现**   | `src/tools/qq.ts`、`src/outbound.ts`           | `reply.*`：随机段间隔、单段 150 字、超 1500 字自动转合并转发                    |
| B2  | 群消息历史不落库    | **待商讨**   | `src/naplink/history.ts`                       | 依赖 B2「分对象记忆存储」的结论；落库 = 新增一份数据留存面                      |
| B3  | 主动回复策略简陋    | **已实现**   | `src/overrides.ts`、`src/session/proactive.ts` | 白名单 `proactive.allowGroups` / `allowUsers` + 每会话 `proactiveProbability`   |
| B4  | 失败文案不可配      | **待实现**   | `src/session/manager.ts`                       | 兜底已实现，文案硬编码                                                          |
| C1  | 无调用链追踪        | **已实现**   | `src/trace.ts`                                 | `trace_id` / `span_id` 贯穿事件接收 → 模型起跑 → 模型处理 → 出站回复            |
| C2  | 配置写入无原子性    | **待实现**   | `src/config.ts`                                | 配置文件只读，没有写入路径；运行状态走 `ctx.storage.set`，未做临时文件 + rename |
| C3  | 面板 API 无契约真源 | **待实现**   | —                                              | 面板尚未开工，开工时的做法参照                                                  |

---

## 四、已实现条目的配置面

| 配置项                        | 默认值                        | 环境变量                           | 对应条目   |
| ----------------------------- | ----------------------------- | ---------------------------------- | ---------- |
| `rateLimit.maxPerMinute`      | `8`                           | `QQ_RATE_MAX_PER_MINUTE`           | A1         |
| `rateLimit.maxPerHour`        | `60`                          | `QQ_RATE_MAX_PER_HOUR`             | A1         |
| `rateLimit.minGapMs`          | `1500`                        | `QQ_RATE_MIN_GAP_MS`               | A1         |
| `rateLimit.stall`             | `false`                       | `QQ_RATE_STALL`                    | AstrBot A1 |
| `rateLimit.stallMaxWaitMs`    | `60000`                       | `QQ_RATE_STALL_MAX_WAIT_MS`        | AstrBot A1 |
| `wake.prefixes`               | `["/"]`                       | `QQ_WAKE_PREFIXES`                 | AstrBot A2 |
| `wake.ignoreAtAll`            | `true`                        | `QQ_WAKE_IGNORE_AT_ALL`            | AstrBot A2 |
| `wake.replyToSelf`            | `true`                        | `QQ_WAKE_REPLY_TO_SELF`            | AstrBot A2 |
| `wake.ignoreAtOthers`         | `true`                        | `QQ_WAKE_IGNORE_AT_OTHERS`         | AstrBot A2 |
| `reply.minDelayMs`            | `0`                           | `QQ_REPLY_MIN_DELAY_MS`            | AstrBot B1 |
| `reply.maxDelayMs`            | `0`                           | `QQ_REPLY_MAX_DELAY_MS`            | AstrBot B1 |
| `reply.segmentChars`          | `150`                         | `QQ_REPLY_SEGMENT_CHARS`           | AstrBot B1 |
| `reply.forwardThresholdChars` | `1500`                        | `QQ_REPLY_FORWARD_THRESHOLD_CHARS` | AstrBot B1 |
| `proactive.allowGroups`       | `[]`（不限制）                | `QQ_PROACTIVE_ALLOW_GROUPS`        | AstrBot B3 |
| `proactive.allowUsers`        | `[]`（不限制）                | `QQ_PROACTIVE_ALLOW_USERS`         | AstrBot B3 |
| `trace.enabled`               | `true`                        | `QQ_TRACE_ENABLED`                 | AstrBot C1 |
| `trace.dir`                   | `""`（与日志同目录）          | `QQ_TRACE_DIR`                     | AstrBot C1 |
| `trace.maxSizeMb`             | `80`                          | `QQ_TRACE_MAX_SIZE_MB`             | AstrBot C1 |
| `trace.retentionDays`         | `7`                           | `QQ_TRACE_RETENTION_DAYS`          | AstrBot C1 |
| `sensitive.enabled`           | `true`                        | `QQ_SENSITIVE_ENABLED`             | A2         |
| `media.allowedDirs`           | `[]`（不放行任何本地文件）    | `QQ_MEDIA_ALLOWED_DIRS`            | A6         |
| `history.count`               | `20`                          | `QQ_HISTORY_COUNT`                 | B1         |
| `log.level`                   | `"info"`                      | `QQ_LOG_LEVEL`                     | C5         |
| `log.dir`                     | `""`（默认目录）              | `QQ_LOG_DIR`                       | C5         |
| `log.maxSize`                 | `"5m"`                        | `QQ_LOG_MAX_SIZE`                  | C5         |
| `log.maxFiles`                | `5`                           | `QQ_LOG_MAX_FILES`                 | C5         |
| `sendDelayMs`                 | `1000`                        | `QQ_SEND_DELAY_MS`                 | B1         |
| `access.allow.groups`         | `[]`                          | `QQ_ALLOW_GROUPS`                  | C6         |
| `access.allow.users`          | `[]`                          | `QQ_ALLOW_USERS`                   | C6         |
| `access.deny.groups`          | `[]`                          | `QQ_DENY_GROUPS`                   | C6         |
| `access.deny.users`           | `[]`                          | `QQ_DENY_USERS`                    | C6         |
| `access.allowAllWhenEmpty`    | `false`                       | `QQ_ALLOW_ALL_WHEN_EMPTY`          | C6         |
| `ownerQQ`                     | 未设置                        | `QQ_OWNER_QQ`                      | C6         |
| `admins`                      | `[]`                          | `QQ_ADMINS`                        | C6         |
| `toolProfilesPath`            | `""`（`tool-profiles.json`）  | `QQ_TOOL_PROFILES`                 | A4         |
| `chatOverridesPath`           | `""`（`chat-overrides.json`） | `QQ_CHAT_OVERRIDES`                | C6         |

取值规则、限制与示例见 [`configuration.md`](./configuration.md)。

---

## 五、待办明细

条目编号在两份对比文档里各自独立编号，下表用「来源」列区分。

### 待实现

| 来源    | #   | 条目          | 前置条件 / 说明          |
| ------- | --- | ------------- | ------------------------ |
| AstrBot | B4  | 失败文案可配  | 文案应走配置，不应走代码 |
| AstrBot | C2  | 配置原子写    | 与面板开工绑定           |
| AstrBot | C3  | 面板 API 契约 | 与面板开工绑定           |

### 待评审

当前没有待评审条目。

### 待商讨

| 来源      | #   | 条目           | 待定问题                                                   |
| --------- | --- | -------------- | ---------------------------------------------------------- |
| qq-bridge | B2  | 分对象记忆存储 | 是否需要独立的记忆面；与 OpenCode 侧记忆能力的职责如何划分 |
| AstrBot   | B2  | 群消息历史落库 | 随上一条；落库还要回答保留期与清理方式                     |

---

## 六、与参照项目仍存的差异（有意保留）

| 方面             | 差异                                                                  | 原因                                                |
| ---------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| 媒体下载传输安全 | 参照项目在证书校验失败时会关闭 TLS 校验继续下载；本项目不接受任何降级 | 降级式安全策略等于把传输安全变成可选项              |
| 工具面默认值     | 参照项目默认把本地执行类工具开放给模型，靠 OS 沙箱兜底                | 本项目没有 OS 沙箱层，默认放开等于无边界            |
| 静态类型         | 参照项目的类型检查配置在两处文件中版本不一致                          | 本项目的类型门禁只有一套，且是 CI 的必过项          |
| 交付形态         | 参照项目是独立进程 + 全栈框架；本项目是插件                           | 模型接入、记忆、检索、沙箱、token 成本都归 OpenCode |

---

## 七、维护约定

1. 条目状态变化时，**先改这份文档**，再回头在两份对比文档的「结论」列标注日期。
2. 新增条目先进对应的对比文档（说明参照依据），评审通过后再在这里登记状态。
3. 已实现条目必须同时给出落点文件；没有落点的「已实现」不成立。
4. 已确认缺陷单独在对比文档里成节，不混进候选条目。
