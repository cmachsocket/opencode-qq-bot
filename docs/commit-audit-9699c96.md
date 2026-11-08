# 提交审计：9699c96..HEAD

> 状态：审计完成，问题已修复。范围内 10 个提交，发现 0 个高危、2 个中危、9 个低危 / 提示，均已处理。

审计范围：`9699c961c3175e36a2615815f7bb5a4b3640507c`（含）到 `HEAD` 的全部提交。

| 提交      | 内容                                                                  |
| --------- | --------------------------------------------------------------------- |
| `9699c96` | 机器级单实例锁、固定机器人工作目录、会话按工作目录创建、Data URL 嗅探 |
| `ba978fc` | 拒绝同一轮内连续调用发送工具                                          |
| `da52ddc` | 表情摘要净化、投递重试上限、缓冲兜底轮询、收藏表情索引重试            |
| `43e9255` | 文档修正                                                              |
| `6ec1734` | 整条入站消息净化、历史补页方向、表格删除、首部空行、日志许可清单等    |
| `735f82d` | 出站发送限流                                                          |
| `40638c0` | 入站图片下载 SSRF 加固                                                |
| `b1a4b86` | 出站凭证拦截                                                          |
| `22a185f` | 脱敏日志落盘与按天 / 按大小滚动                                       |
| `215a185` | 出站媒体目录白名单                                                    |

验证基线：`tsc --noEmit` 通过，`eslint .` 无告警，`vitest run` 25 个文件 / 429 个用例全绿。
上游核对：`@opencode/plugin` / `@opencode/schema` 的 `tool.d.ts`、`session.d.ts`；
NapCat `#987`、`#441`、`PR #944` 与 OmniQQ MCP 的 `message_seq` 游标说明；
`request-filtering-agent` 3.2.1 的 README 与类型声明。

---

## 高危

未发现高危问题。入站 SSRF、出站媒体目录、出站凭证拦截三条边界的默认路径均按预期拒绝，
没有发现可直接读取任意本地文件、访问内网或把凭证发到 QQ 的绕过方式。残余风险见低危项。

---

## 中危

### 1. 同进程接管时 `closeLogger()` 会把新实例的日志器一起关掉

`src/logger.ts:68` 用模块级 `handles` 保存所有日志器，`closeLogger()` 在
`src/logger.ts:251-266` 直接快照并关闭全部句柄，而不是只关闭当前实例。

接管顺序恰好踩中这一点：

1. `src/index.ts:54` 先创建新实例的日志器，并加入 `handles`；
2. `src/index.ts:76-88` 调 `claimInstance`，如果存在旧实例则 `await previous.dispose()`；
3. 旧实例的 `dispose` 在 `src/index.ts:436-437` 调 `flushLogger()` + `closeLogger()`；
4. 新实例刚创建的日志器也在 `handles` 里，于是 console 与文件传输一起被关闭。

实测两个日志器后调用一次 `closeLogger()`，再向第二个日志器写入：

```
[winston] Attempt to write logs with no transports, which can increase memory usage:
  {"level":"info","message":"after-close",...}
qq-bot-YYYY-MM-DD.log   // 为空
```

接管后新实例仍能正常收发 QQ 消息，但所有日志（含文件日志）失效，排障信息丢失。
另外 `src/index.ts:80-82` 的 `occupied` 分支直接返回，没有关闭第 54 行刚创建的日志器，
也没有注册 dispose，文件句柄会一直留到进程退出。

建议：让 `createLogger` 返回带 `close()` 的实例，或让 `closeLogger()` 接受目标句柄；
`dispose` 只关闭自己的日志器。`occupied` / 配置解析失败等提前返回路径也要显式关闭。

位置：`src/logger.ts:68,251-266`，`src/index.ts:43,54,76-91,436-437`

### 2. 补历史失败仍会被标记为“已补齐”

`6ec1734` 把 `historyDone = true` 从取历史之前挪到了 `history.fetch()` 之后
（`src/session/manager.ts:539,552`），本意是失败后下一轮重试。但失败在更底层被吞掉了：

- `src/naplink/history.ts:187-206` 的 `requestHistory` 捕获所有异常，只写一条 warn，
  然后返回空数组；
- `createHistoryProvider().fetch` 在 `src/naplink/history.ts:65-73,95` 把空数组当成
  “没有历史”，正常返回 `{ text: "", files: [] }`；
- `prepareTurn` 看到 Promise 正常 resolve，就在 `src/session/manager.ts:552` 置位
  `historyDone = true`，`559-561` 的 catch 永远不会执行。

于是 NapCat 短暂超时、断线或接口报错一次，该目标在本次进程生命周期内就永久不再补历史，
与 CHANGELOG 中“现在补成功才算补过，失败下一轮重试”不符。`tests/history.test.ts:184-191`
还明确断言“接口报错返回空”，把这一行为固定了下来（但该测试只测 provider，不测 manager 的标记）。

建议：让 provider 返回成功标志（或失败时抛错），`prepareTurn` 只在真正成功时置位；
“接口成功但没有消息”仍算成功。补一条“第一次失败、第二次成功”的 manager 回归用例。

位置：`src/naplink/history.ts:65-73,187-206`，`src/session/manager.ts:537-561`，
`tests/history.test.ts:184-191`

---

## 低危 / 提示

### 3. 发送工具返回 `error:` 文本时不会撤销连续发送标记

`src/tools/send-guard.ts:49-56` 只在 `event.status === "error"` 时清除 `send` 标记。
但 OpenCode 的工具钩子语义是：**返回 `{ content: ... }` 属于 `completed`，只有抛出的
Error 才是 `error`**（`node_modules/@opencode/plugin/dist/promise/tool.d.ts`）。

`src/tools/qq.ts` 有多条失败路径返回文本而不是抛错，例如：

- `send_message` 发送异常：`src/tools/qq.ts:291-295`
  `return text("error: 消息只发送了 0/N 段")`；
- 限流拒绝：`src/tools/qq.ts:179-183` 的 `refuse`；
- 参数校验失败：缺少 `file`、缺少 `id`、`nodes` 为空等
  （`src/tools/qq.ts:246-266,318-321,367-380,408-410,452-473`）。

以第一段就失败（实际一条都没发出）为例：

```
send_message → 返回 "error: 消息只发送了 0/1 段"（status = completed）
send-guard 不清 send 标记
模型立刻重试 send_message → execute.before 命中 previous.send
→ 抛 DUPLICATE_SEND_REFUSAL
```

这与 CHANGELOG“发送失败时允许立即重试”不符。模型仍可通过先调用任意其它工具解除限制，
但多了一次无意义的往返，且失败原因与拒绝原因互相矛盾。限流拒绝刻意标记已回复是另一回事，
可以保留。

建议：发送工具在“完全没发出去”时抛错；或让 `execute.after` 识别结果为错误文本；
或由发送工具显式调用 manager 撤销本轮发送标记。补一条“返回 error 文本后允许重试”的用例。

位置：`src/tools/send-guard.ts:49-56`，`src/tools/qq.ts:179-183,246-266,291-295,452-473`，
`CHANGELOG.md:132-133`

### 4. 合并转发节点的 `nickname` 没有做凭证扫描

`src/tools/qq.ts:458-468` 只把节点正文 `toPlainText(node.content)` 交给 `guardOutbound`，
随后把未扫描的 `node.nickname` 一起发给 NapCat：

```
guardOutbound(target, body)                 // 只扫正文
nickname: node.nickname?.trim() || "未知用户" // 原样发送
```

模型（或被提示词注入的模型）可以把凭证放进昵称，绕过 `send_forward` 的凭证拦截。
风险低于正文外发，但确实是同一条出站链路上的缺口。

建议：把 `nickname` 与正文一起扫描，或分别调用 `guardOutbound`。

位置：`src/tools/qq.ts:458-468`

### 5. 日志打码没有做 NFKC / 零宽归一化

`SensitiveChecker.check` 在 `src/sensitive.ts:244-247` 会先做 NFKC 与零宽字符清理，
但日志侧 `maskSecrets` 在 `src/sensitive.ts:285-300` 直接对原始行调用 `redact`。
全角或零宽混淆的凭证能通过出站拦截（因为 check 会归一化），却会原样写进日志：

```
maskSecrets("key=ＡＫＩＡＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰ")
  === "key=ＡＫＩＡＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰ"   // 未打码
new SensitiveChecker().check(同上).allowed === false
  // hits: ["aws_access_key"]
```

日志里出现这种混淆形式的概率不高，但“出站拦得住、日志漏出去”与
`docs/configuration.md` 的脱敏承诺不一致。

建议：对用于检测的副本做 `normalizeText`，再按命中位置回写原文；至少对归一化后的行做一次
补充打码。补一条全角凭证的日志用例。

位置：`src/sensitive.ts:244-247,285-300`，`src/logger.ts:129-137`

### 6. `defaultLogDir()` 接受相对路径的 `XDG_STATE_HOME`

`src/logger.ts:76-80` 只要 `XDG_STATE_HOME` 非空就直接使用；`src/home.ts` 与
`src/media-path.ts` 都要求该变量是绝对路径，否则回退默认目录。相对值会让日志落到
进程当前目录下的相对路径，可能随启动目录漂移，甚至因目录不可写而静默丢日志。

建议：与 `home.ts` / `media-path.ts` 保持一致，只接受绝对路径，否则回退
`~/.local/state`。

位置：`src/logger.ts:76-80`

### 7. 入站 HTTP 图片信任声明的 `image/*` 类型

`src/naplink/media.ts:181-190` 在 HTTP 下载路径上优先使用响应头的声明类型：

```ts
const declared = response.contentType?.split(";")[0]?.trim()
const mime = declared?.startsWith("image/") === true ? declared : mimeFromBytes(...)
```

Data URL 与 `base64://` 路径会嗅探魔数（`src/naplink/media.ts:151-158`），HTTP 路径不会。
服务器返回 `Content-Type: image/png` 但正文是 HTML、或返回 `image/svg+xml` 时，都会按声明
类型存盘；后者因 `MIME_EXTENSIONS` 没有 svg 而落到 `.bin`，模型侧可能拿到无法识别的文件。
这不是 9699c96 声称修复的 Data URL 问题，但属于同一处“声明类型 vs 实际内容”的不一致。

建议：HTTP 路径也以魔数为准；声明为 `image/*` 但与魔数不符时告警并回退，无法识别则拒绝。

位置：`src/naplink/media.ts:151-158,181-190`

### 8. `FavoriteStore.list()` 在等待在途请求后会再发一次请求

`src/emoji/favorites.ts:96-108`：

```ts
const inflight = this.inflight
if (inflight) await inflight.catch(() => {})
this.inflight ??= this.fetch()...
```

在途请求完成后会填充 `cache`，但这里没有重新检查缓存，`inflight` 已被清空，于是紧接着又发
一次 `fetch_custom_face_detail`。`refresh: false` 的调用方在缓存为空 / 过期且已有在途请求时，
会多打一次 NapCat 接口。功能不受影响，属于 `da52ddc` 修复“刷新被在途请求吞掉”时带入的冗余。

建议：等待结束后，非刷新调用重新检查 `cache`；只有 `refresh: true` 或缓存仍无效时才新建请求。

位置：`src/emoji/favorites.ts:96-108`

### 9. 表情标签会话没有固定到机器人工作目录（遗留）

`src/emoji/label.ts:203-208` 创建标签会话时没有传 `location`，会落在当前加载插件的项目目录；
`src/emoji/label.ts:215-225` 读回存储的会话时也没有校验 `info.location.directory`。
同样的问题在保活会话上已经修过（`src/keepalive.ts:162-173` 会拒绝别的工作目录留下的会话）。

该问题在 `c28d19a`（范围之前）引入，不在本次提交的改动里，但它与本轮“QQ 会话固定到机器人
工作目录”的目标直接相关：切换活动项目后，标签会话可能仍留在旧项目目录，或复用旧项目里的会话。
风险低（仅影响 `/emoji-label`），建议顺手补上 `location` 与目录校验。

位置：`src/emoji/label.ts:203-208,215-225`，对照 `src/keepalive.ts:162-173`

### 10. `hydrateMedia` 已无生产调用

`9699c96` 删除了渲染前的整批 hydrate，改为在 `render.ts` 里逐段 `hydrateSegment`。
`src/naplink/client.ts:79-86` 的 `hydrateMedia` 目前只被 `tests/client.test.ts:3,114-122`
引用，生产代码不再调用。保留它会让后续维护误以为还有一条整批补全路径。

建议：删除导出与对应测试，或明确标注为测试辅助 / 兼容接口。

位置：`src/naplink/client.ts:79-86`，`tests/client.test.ts:3,114-122`

### 11. `fetchGap` 的 10 页上限会静默截断较长离线期

`src/naplink/history.ts:143-166` 最多翻 `MAX_HISTORY_PAGES`（10）页。若离线期间的消息超过
`10 * history.count` 条，循环结束时 `reached` 仍为 false，随后按时间切出“最新的一段”注入，
并照常置位 `historyDone`；更早的那段缺口以后不会再补。这个上限本身是合理的保护，
但当前没有任何日志提示发生了截断。

建议：命中页数上限且未到达上次位置时写一条 warn，说明只补了最近一段。

位置：`src/naplink/history.ts:143-166`

---

## 核对通过的部分

- **单实例与工作目录固定**：机器级锁固定为 `$TMPDIR/opencode-qq-bot.lock`
  （`src/bot-lock.ts:33-34`），不再随 NapCat endpoint / token 变化；进程内注册表按
  `home.directory` 区分（`src/instance.ts`），不同工作目录的实例不会互相接管。
  聊天会话创建时显式传 `location`（`src/session/manager.ts:790`），历史会话也按
  `this.location.directory` 查找（`src/session/manager.ts:859`）；`home` 支持
  `QQ_BOT_HOME` / XDG 数据目录并在启动时创建。保活会话的目录校验与卸载删除也已生效
  （`src/keepalive.ts:162-173`）。
- **入站 SSRF**：`safeFetchBytes` 只允许 http/https 与 80/443/8080/8443
  （`src/safe-fetch.ts:7,55-71`），非 2xx、超时、超过 `content-length` 或流式上限都会终止；
  DNS 解析交给 `request-filtering-agent`，只放行单播地址，且用校验后的地址连接、保留原
  Host / SNI。`tests/safe-fetch.test.ts` 覆盖了 loopback、私有网段、保留地址、端口、重定向、
  大小上限与超时。
- **出站媒体目录**：本地文件先做词法解析与 `realpath`，两套路径都必须落在工作目录、媒体目录
  或 `media.allowedDirs` 内（`src/media-path.ts:140-154`），目录边界带分隔符，符号链接逃逸
  会被拒绝；目标必须是普通文件。远程 URL 只允许白名单端口，且所有解析地址都必须是公网
  （`src/media-path.ts:58,123`）。`tests/media-path.test.ts` 覆盖了相对路径、越界、符号链接、
  边界目录、私网 / 本机 / 非白名单端口。DNS 重绑定与 NapCat 二次解析之间的 TOCTOU 在代码
  注释中已说明，属于当前架构下的已知限制。
- **出站凭证拦截**：`SensitiveChecker` 会做 NFKC、零宽清理、base64 变体解码、已知凭证片段
  匹配与凭证文件路径识别（`src/sensitive.ts`）；PII 检测器保持关闭，避免正常聊天被误拦。
  拦截覆盖 `send_message`、`send_image`、`send_record`、`send_sticker`、`send_forward`
  （`src/tools/qq.ts:268,321,380,410,464`），命中时抛错并说明原因。`tests/sensitive.test.ts`
  覆盖了普通聊天、API key、全角 / 零宽、base64、已知凭证拆分、凭证路径与关闭开关。
- **出站限流**：按目标分作用域，硬上限拒绝、`minGapMs` 先等后发，同一次工具调用的多段共用
  operation id、不叠加间隔；插件消息走 `#plugin` 作用域，只做节奏控制、不拒绝
  （`src/rate-limit.ts:88-149`）。`tests/rate-limit.test.ts` 覆盖了分钟 / 小时窗口、间隔、
  多目标隔离、插件作用域与 `0` 关闭。限流拒绝后标记本轮已回复是文档写明的行为。
- **日志落盘与脱敏**：console 保持旧格式，文件为按天滚动的 JSONL；`maskFormat` 位于
  console 与文件两条管道的最后，整行（含 meta）统一打码（`src/logger.ts:129-137,172-197`）；
  已知凭证来自环境变量与 NapCat token。`tests/logger.test.ts` 覆盖了级别过滤、格式、JSONL、
  打码、误报、目录创建、滚动与 XDG 默认值。除上面的关闭范围与相对 XDG 两个问题外，主体正确。
- **入站净化**：整条消息拼接完成后统一 `neutralizeStructureTags`，插件自己的
  `<quote>` / `<forward>` / `<history>` 用私用区占位符保护、净化后再还原
  （`src/naplink/render.ts` 最终拼接处），跨段伪造已被堵住；发送者名称、表情摘要、文件名、
  语音转写也各自净化。`tests/render.test.ts` / `tests/model-view.test.ts` 覆盖了拆分标签、
  私用区字符与占位符还原。
- **历史补页方向**：`fetchGap` 传 `reverse_order: true`，游标取页内最旧一条的 `message_id`
  （`src/naplink/history.ts:128-166,187-206`），与 NapCat `#987` / `#441` / `PR #944` 的语义
  及 OmniQQ 的游标说明一致；`fetchLatest` 仍从 `"0"` 往当前时间取。方向问题本身已修复，
  剩下的只是失败标记问题（中危 2）。
- **文档与许可**：`NOTICE` 已补齐 `flare-redact`、`ipaddr.js`、`request-filtering-agent`、
  `winston`、`winston-daily-rotate-file` 等直接依赖，并说明 `@opencode/plugin` /
  `@opencode/schema` 没有独立 LICENSE 文件；`docs/configuration.md` 与 README / `.env.example`
  已登记 `home`、`rateLimit.*`、`sensitive.enabled`、`log.*`、`media.allowedDirs`，
  `tests/docs.test.ts` 能守住环境变量清单的一致性。
- **测试覆盖缺口**：现有 420 个用例没有覆盖 `closeLogger` 的作用域（中危 1）、provider 失败后
  的 `historyDone`（中危 2）、以及“返回 error 文本的发送工具”与连续发送标记的交互（低危 3）。
  建议在修这三项时一并补上。

---

## 修复记录

| 问题    | 修复内容                                                                         | 回归用例                                                                     |
| ------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 中危 1  | `closeLogger` / `flushLogger` 接受目标日志器；提前返回路径关闭兜底日志器         | `tests/logger.test.ts`「只关闭指定的日志器」                                 |
| 中危 2  | `requestHistory` 失败向上抛错，`prepareTurn` 只在成功时置位 `historyDone`        | `tests/history.test.ts`、`tests/manager.test.ts`「补历史失败后下一轮继续补」 |
| 低危 3  | 工具错误结果带 `failed` 标记，发送守卫据此撤销标记；部分发送与限流拒绝保持已发送 | `tests/send-guard.test.ts` 新增两条                                          |
| 低危 4  | `send_forward` 把昵称与正文一起做凭证扫描                                        | `tests/tools.test.ts`「blocks forward nicknames…」                           |
| 低危 5  | 日志打码先检查归一化后的文本，混淆凭证整行丢弃                                   | `tests/sensitive.test.ts`「归一化后命中的混淆凭证整行丢弃」                  |
| 低危 6  | `XDG_STATE_HOME` 只接受绝对路径                                                  | `tests/logger.test.ts` 默认目录用例                                          |
| 低危 7  | HTTP 入站图片统一按魔数判定类型                                                  | `tests/media.test.ts`「按魔数判定而不是信任声明类型」                        |
| 低危 8  | 非刷新调用复用同一在途请求结果                                                   | `tests/emoji.test.ts`「shares the request in flight…」                       |
| 低危 9  | 标签会话固定到 `home`，读回时校验目录                                            | `tests/emoji.test.ts`「ignores a stored label session…」                     |
| 低危 10 | 删除 `hydrateMedia` 及其测试                                                     | `tests/client.test.ts`                                                       |
| 低危 11 | 补页触顶时记录 warn                                                              | —                                                                            |

## 修复顺序（已全部处理）

1. 中危 1：`closeLogger` 只关自己的日志器，提前返回路径也关闭（日志是排障前提）
2. 中危 2：补历史失败不置位 `historyDone`，provider 返回成功标志
3. 低危 3：发送失败 / 校验失败时撤销连续发送标记
4. 低危 4：`send_forward` 的 `nickname` 纳入凭证扫描
5. 低危 5：日志打码前做 NFKC / 零宽归一化
6. 低危 7：HTTP 入站图片统一按魔数判定类型
7. 低危 6 / 8：相对 XDG 回退、`FavoriteStore.list` 重复请求
8. 低危 9 / 10 / 11：表情标签会话目录、删除 `hydrateMedia`、补页上限告警
