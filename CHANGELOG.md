# Changelog

本文件记录 opencode-qq-bot 的重要变更。

## [Unreleased]

### Added

- 冷启动补历史：新建会话或重启后恢复会话时，把最近的历史消息以 `<history>` 文本块拼进首轮提示。
  新建会话补最近 `history.count` 条（默认 20）；重启恢复时从上次投递到的位置之后补增量。
  历史里的图片会下载进会话、语音会转写，群公告 / 成员变动等非消息事件不补。
  新增配置项 `history.count`（`QQ_HISTORY_COUNT`），`0` 表示关闭。
- 保活心跳：OpenCode 按 location 统计会话活动，默认空闲 60 分钟后卸载该 location 的服务，
  插件随之被卸载，NapCat 连接断开后机器人不再响应。插件现在每隔 `keepAlive.seconds`
  （默认 1200 秒）原样写回一次会话元数据，产生一条带 location 的 durable 会话事件，
  把空闲计时重置。心跳跑在一个不绑定 QQ 目标的专用会话上（标题 `QQ 保活`），
  不影响群聊会话，也不消耗模型调用。新增配置项 `keepAlive.enabled`
  （`QQ_KEEP_ALIVE_ENABLED`）与 `keepAlive.seconds`（`QQ_KEEP_ALIVE_SECONDS`）。
  推荐同时在 `opencode.json(c)` 里设置 `experimental.location_idle_timeout: false`，
  彻底关掉 OpenCode 的自动卸载；插件卸载时的日志也会提示这一项。

### Changed

- 出站文本质量：模型回复里的 markdown 会先剥成纯文本再发出去（`remove-markdown`）——
  标题、强调、代码围栏、HTML 标签去掉，列表符号去掉只留正文，表格整块丢弃，
  链接与图片保留 URL（`文档: https://...`）。超长消息改用 `Intl.Segmenter`
  按字素簇切分，不再切坏 ZWJ emoji 序列、肤色修饰符、区域指示符旗帜和组合字符。
  只作用于模型产出的文本（`qq_send_message` 的 content 与 `qq_send_forward` 的节点文本），
  插件自己生成的提示文本保持原样。
- `warnLength` 默认值从 `20` 改成 `500`：原值下几乎每条回复都会告警，告警因此失去意义。
  判定口径是单次发送的内容长度，只告警，不截断也不影响发送。

### Fixed

- 只含 QQ 官方表情（`face`）的消息、只含 `at` 的消息被整条丢弃：门卫只放行
  `text` / `image` / `record` / `forward` / `reply`，其余段类型即使渲染器支持也会被挡掉。
  现在门卫按"渲染器能产出文本的段类型"放行，`video` / `audio` / `file` / `json` /
  `xml` / `markdown` 同样不再被丢。
- `.env.example` 仍列着 0.3.2 已移除的 `QQ_BUSY_TIMEOUT_MS`，并把默认角色设定写成包内
  `SOUL.txt`（实际是 `souls/default.txt`）；同时补上漏掉的 `QQ_BOT_SOUL_NAME`。
- README 里 `warnLength` 的说明写成「一轮回复总长度」，与实现（单次发送的内容长度）不符。

## [0.4.0] - 2026-11-07

### Added

- 收藏表情（表情包）：`/emoji-label all|inc|list` 用模型给收藏表情生成中文标签，
  标签写在 NapCat 的 `desc` 字段里；新增 `qq_favorite_list` 列出编号与标签，
  `qq_send_sticker` 按编号发回收藏表情。编号只是发图片的句柄，由插件自己维护
  （从 1 开始，存在插件存储里），身份依据是图片 `md5`，
  和 NapCat 的 `emo_id` / `res_id` 解耦。详见 [docs/emoji.md](docs/emoji.md)。

### Changed

- QQ 官方系统表情（`face` 段）渲染成 `[得意]` 这样的名称，未收录的 ID 回退成 `[表情:ID]`；
  收到的收藏表情保留 NapCat 给的摘要，不再统一显示成 `[图片]`。

## [0.3.4] - 2026-11-06

### Fixed

- 同一条 QQ 消息被重复投递给模型：机器上多个 OpenCode 实例（不同进程或不同工作区）各自
  向 NapCat 建立反向 WebSocket，NapCat 会把同一条消息推给所有连接，模型就会收到多份。
  现在按 NapCat 端点加跨进程身份锁，同一时间只有一个实例消费消息流，其余实例不连接
  NapCat，并定期尝试接管。锁用 `@bybrave/proper-lockfile2` 实现，基于文件系统，
  Windows、macOS、Linux 行为一致；持锁进程崩溃后锁目录过期即可被接管。
- 锁心跳失效说明锁已不再独占，实例可能正在和别的实例一起消费消息流。现在立刻停止
  投递消息，等重新抢到锁再恢复。
- 投递失败后会把缓存消息重新合并，合并结果沿用第一条消息的 ID 却带上新的内容，上游按
  ID 去重时判定为冲突，消息于是反复重投。失败的一批现在单独冻结（ID 与内容都不变），
  重试时原样重发，新到的消息另起一批。

## [0.3.3] - 2026-11-06

### Fixed

- `session.prompt` 的 `id` 必须是 `msg_` 开头的上游消息 ID，此前传入普通 UUID 会让
  每次投递都报 `SchemaError: Expected a string starting with "msg_"`。现在改用
  `@opencode/schema` 的 `SessionMessage.ID.create()` 生成，重试时继续复用同一个 ID。

## [0.3.2] - 2026-11-06

### Fixed

- 忙碌期间收到的消息迟迟不处理：插件靠 `session.idle` 判断一轮结束，但该事件已废弃，
  2.2.5 实际只在执行结束时发送 `session.execution.succeeded`，事件不会到达，只能等
  5 分钟看门狗强制放行。现在监听 `session.status` 和执行结束事件，收到后立即投递缓存。
- 不再单独维护“会话是否忙碌”的本地状态：每次投递前读取上游的
  `time.busy` / `time.idle`，上游仍在执行就把消息留在队列里，确认空闲后再合并投递。
  正常的长轮次不会被误伤；`QQ_BUSY_TIMEOUT_MS` 配置项一并移除。
- 同一目标的消息处理、状态变更和投递统一用 `async-mutex` 串行化，避免并发提交和
  状态互相覆盖。
- 上一轮迟到的 idle/结束事件会误清当前轮次并绕过投递宽限：现在先比对上游
  `time.idle` 与本次投递时间，确认属于旧轮次就忽略。
- 同一条 QQ 消息被 NapCat 重放时会重复入队：现在按 `message_id` 去重。
- 投递超时但上游其实已接收时，重试可能重复执行同一轮：每轮生成稳定的幂等键并通过
  `session.prompt` 的 `id` 传递。

## [0.3.1] - 2026-11-06

### Fixed

- 图片消息无法进入模型：NapCat 的图片段同时带有本地路径和 CDN 直链，naplink SDK 的
  `hydrateMessage` 会优先选用 NapCat 服务器上的本地路径，覆盖掉可用的 CDN 直链，
  导致图片下载必然失败。插件现在自行补全直链，已有 http(s) 地址不覆盖，并优先使用
  远程直链；引用消息与合并转发里的图片同样生效。
- 图片地址不受支持时 `MediaStore` 会静默失败，现在会打印警告便于排查。

## [0.3.0] - 2026-11-06

### Added

- 角色设定支持多份并存：`souls/` 目录里可以放多个文件，用 `soulName`（环境变量
  `QQ_BOT_SOUL_NAME`）选生效的那份，`soulPath` 可以覆盖成任意文件或目录。
- 角色设定热更新：生效文件的内容改动会被监听，下一轮立即用新设定；文件稍后创建也会被捡到。
- QQ 会话里拦截内置 `question` 工具，拒绝并要求模型改用 `qq_send_message` 询问用户。

### Changed

- 角色设定从包根目录的 `SOUL.txt` 移到 `souls/default.txt`。

## [0.2.0] - 2026-11-05

### Fixed

- 布尔环境变量全部失效：`QQ_REUSE_SESSION`、`QQ_PROACTIVE_ENABLED`、`QQ_REMINDER_ENABLED`
  之前只接受原生 boolean，环境变量里的 `"true"` / `"false"` 会被忽略并退回默认值。
  现在支持 `true/false`、`1/0`、`yes/no`、`on/off`（不区分大小写）。
- 数值环境变量全部失效：`QQ_SEND_DELAY_MS`、`QQ_WARN_LENGTH`、`QQ_BUSY_TIMEOUT_MS`、
  `QQ_PROACTIVE_SILENCE_SECONDS`、`QQ_PROACTIVE_P_START`、`QQ_PROACTIVE_P_SLOPE_PER_HOUR`、
  `QQ_PROACTIVE_TICK_SECONDS`、`QQ_REMINDER_MAX` 之前只接受原生 number，
  环境变量里的数字字符串同样会被忽略。现在按字符串解析。
- 内联图片没有数量与总量上限，单条消息可能塞进几十 MB 的 base64：现在单轮最多 8 张、
  原始字节总量最多 16MB，超出的图片只保留占位文本，合并转发与多轮合并同样受限。
- 图片 MIME 只信 `content-type`，NapCat 返回 `application/octet-stream` 时会被当成 PNG：
  现在用魔数兜底识别 PNG/JPEG/GIF/WebP，扩展名也随之修正。
- 图片先整包下载再判断大小，超大图会先打满内存：现在先看 `content-length`，读取时限长中断。
- 消息监听注册晚于连接，NapCat 在连接期间推送的消息会丢：现在先注册监听再连接。
- 后台任务运行时仍会清掉忙碌标记，新消息被插进正在执行的会话导致顺序倒置：
  现在后台任务未结束前保持忙碌，等真正空闲再冲刷缓存。
- 提醒预算只在模型调用发送工具时归零，连续几轮不调用工具后该群再也不提醒：
  现在每个新的用户轮次都会重置预算。
- `model` 写错时静默失效：现在会输出告警，其余写错的配置项同样有告警。
- `@` 检测改为严格比较后，运行时 QQ 号是数字就会失效：现在统一按字符串比较。
- NapLink 日志级别设为 `warn`，吞掉了 SDK 自己的重连日志：现在恢复为 `info`。
- 图片以 base64 字符串进入插件缓存和每轮 prompt：现在下载到受控临时目录，以 `file:`
  引用交给会话；临时文件默认保留 7 天并定期清理。
- 图片下载没有超时、跟随重定向、可访问内网地址：现在 15 秒超时、拒绝重定向、
  拒绝本机与内网地址，并按魔数校验类型。
- 模型失败、中断或长时间无响应后忙碌状态卡死：现在监听执行失败/中断事件并增加超时看门狗，
  只把本会话自己的后台任务算作忙碌。
- 主动说话与用户消息并发、并发创建会话、绑定被覆盖：现在提前占位、`ensureSession`
  单飞、已有绑定拒绝覆盖。
- 恢复的会话已被删除时每条消息都失败：现在校验会话存在性，失效后自动解绑重建。
- 同一群的消息可能因媒体下载乱序入队：现在按群串行处理。
- 群工具缺少配置与轮次校验，且只有文本发送会记账：现在工具要求群仍启用且处于 QQ 轮次，
  媒体/转发/戳一戳成功也标记已回复；撤回与语音转写只接受机器人发送或最近收到的消息。
- `qq_send_message` 按行拆分破坏排版、部分失败不记账：现在保留原文，仅在超长时分段，
  部分成功也标记已回复；`reply=false` 时 `content` 可省略。
- 配置未知键被静默剥离、数值越界、群号重复或非法：现在告警并回退，群号去重。
- 引用与转发只保留文本、无发送者节点被丢弃、嵌套转发无全局预算、成员名无缓存：
  现在补齐占位与图片、保留匿名节点、限制整棵转发树、缓存成员名。
- `session.idle` 订阅异常退出后不再冲刷缓存：现在自动重试。

### Changed

- 群与会话的绑定写入插件存储（`ctx.storage`），插件重启后自动沿用原来的会话，
  不再每次启动都新建一个；存储读写失败只告警，不影响正常收发。
- 许可证改为 CC BY-NC-SA 4.0：非商业使用，衍生作品必须按同一许可共享；
  `package.json` 与 `LICENSE` 同步更新。
- 群与会话严格一对一：一个会话只能绑定一个群，复用到已绑定其他群的会话时改为新建会话。
- 合并的消息改为在会话真正空闲（`session.idle`）后作为新的一轮投递，
  不再挤进上一轮的钩子里。
- 真实群号不再提交：`opencode.json` 改为本地配置并被 `.gitignore` 忽略，
  仓库只保留 `opencode.example.json` 模板。
- 群活跃时间写入插件存储，重启后静默时长继续累计；主动说话概率按心跳间隔换算。
- 依赖锁定到具体版本，移除不必要的 TypeScript peer 依赖，补充 `main`/`types` 导出。
- 发送延迟改用 `setTimeout`，不再绑定 Bun 运行时。

## [0.1.0] - 2026-11-04

### Added

- 首个版本：NapLink（OneBot 11）接入 OpenCode V2 插件。
- 群消息 → OpenCode 会话 → `qq_*` 工具回复到群。
- 会话忙碌时缓存消息、空闲后合并成一轮。
- 语音转写、图片内联、引用与合并转发展开。
- 角色设定 `SOUL.txt`、系统提示注入、主动说话心跳、发送工具漏调用提醒。
