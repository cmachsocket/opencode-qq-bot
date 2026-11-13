# Changelog

本文件记录 opencode-qq-bot 的重要变更。

## [Unreleased]

### Breaking Changes

- `chat-overrides.json` 的会话键改成与全局配置项同名：`prefix` → `wake.prefixes`（字符串数组）、
  `proactive` → `proactive.enabled`、`proactiveProbability` → `proactive.startProbability`、
  `soul` → `soulPath` / `soulName`。旧键名直接失效，没有迁移层。

### Added

- 面板新增两个独立配置页，不用再手改 JSON：
  - 「会话覆盖」页编辑 `chat-overrides.json`：按聊天键（`group:100` / `private:200`）列出覆盖项，
    可新增、修改、删除；可编辑字段与后端 `ChatOverride` 一一对应（`wake`、`wake.prefixes`、
    `proactive.enabled`、`proactive.startProbability`、`agent`、`model`、`soulPath`、`soulName`）。
  - 「工具档案」页编辑 `tool-profiles.json`：改默认配置档、各档的 `allow` / `deny` 工具模式列表，
    以及聊天键到配置档的映射；内置档（`chat`、`readonly`、`proactive`、`admin`）标出来且不可删。
  - 接口：`GET/PUT /api/chat-overrides`、`GET/PUT /api/tool-profiles`。
  - 校验一律复用运行时的解析函数：单个字段写错只忽略该项并告警，其余照常生效；
    聊天键、档名与档引用不合法时按字段给出原因。保存用与 `config.json` 一样的原子写，
    文件 `0600`、目录 `0700`，各留一份 `.bak`。
  - 两个文件都按修改时间热加载，保存后无需重启；命中已知凭证的字段不回显。
- 面板前端也有测试了：vitest 增加一个 jsdom 工程（`tests/web/`），用 @testing-library/svelte
  挂载页面，验证列表渲染、保存请求体、删除动作与服务端返回的字段错误提示。

### Fixed

- 面板的保存按钮恢复可用：面板 CSP 是 `script-src 'self'`，而前端用 `ajv` 编译 JSON Schema
  校验器需要 `eval`，点击保存只会抛 `EvalError` 并被吞掉。现在前端不再做本地校验，
  由后端 zod 校验并返回逐字段原因——本来就以后端为准。
- 前端构建不再报 `baseUrl` 弃用警告：`web/tsconfig.json` 去掉 `baseUrl`，
  `paths` 改为相对配置文件本身解析。

## [0.9.2] - 2026-11-13

### Added

- 收藏动画表情的工具 `qq_collect_sticker`：把群里别人发的动图收进收藏夹，和 QQ 收藏表情
  共用一套编号，列表里标注「本机收藏」。
  - 调用时必须给 `description`：一个不超过 12 个字、只用文字和数字的中文名字；不合规时工具
    退回规则原文，让模型改一个名字再调一次。
  - OneBot 没有「添加收藏表情」的动作，收藏的图片由插件存在媒体目录的 `favorites/` 子目录里，
    元数据写在插件存储里，最多存 200 个。

### Fixed

- 面板里 `proactive.allowGroups` / `proactive.allowUsers` 的说明改成「留空表示一个都不主动说话」：
  之前的「留空表示不限制」与实际行为相反，白名单为空时插件一个聊天都不会主动开口。

## [0.9.1] - 2026-11-12

### Changed

- 状态面板默认开启（`panel.enabled` 默认 `true`），仍只监听 `127.0.0.1:7391`。
  面板开着而没有令牌时自动生成一个并写回 `config.json`；令牌由配置控制器统一补齐，
  启动与运行中打开面板都拿得到。

### Added

- 最小配置模板 `config.example.json`：复制到工作目录改名成 `config.json` 即可用，npm 包里也带一份。

### Fixed

- 面板开着却没有令牌时也能进得去：之前只在「启动时已开启」这条路上生成令牌，
  运行中打开面板会变成一个登不进去的面板。
- 换端口失败不再把面板关掉：端口被占用时旧服务照常可用，也不会抛出没人接的 Promise 拒绝。
- 文档里的配置示例回到新结构：README 的安装示例不再把 `napcat` / `access` 写成插件选项，
  角色设定的示例改用 `config.json` 的 `soulName`；`docs/diary.md` 的日记配置项不再引用
  已删除的 `QQ_DIARY_*` 环境变量；`SECURITY.md` 不再让人提交 `.env.example`。

## [0.9.0] - 2026-11-12

### Breaking Changes

- 配置来源收敛到 `config.json`：文件固定放在 `$XDG_DATA_HOME/opencode-qq-bot/workspace`
  （默认 `~/.local/share/opencode-qq-bot/workspace`），工作目录不可配置。
  `config.json` 不存在或 JSON 非法时插件直接报错退出，不再用默认值静默启动。
- 环境变量整体退出配置体系：`NAPCAT_*`、`QQ_*` 等旧变量不再读取，`.env.example` 已删除。
- OpenCode 插件选项只剩 `agent`；`napcat`、`access` 等其余选项不再生效，也不会有迁移提示。
- 没有兼容层、迁移工具或新旧字段对照表：升级时必须按
  [docs/configuration.md](docs/configuration.md) 的字段表手写一份 `config.json`。
- `home` 不再是配置项，工作目录固定；`agent` 只从 `opencode.json` 的插件选项读取，
  `model` 改为 `config.json` 里的偏好。

### Added

- 配置中心与状态面板：默认关闭，启用后默认只监听 `127.0.0.1:7391`，用令牌登录。
  - 配置表单由字段注册表自动生成，支持保存、热更新与「需重启」提示。
  - 状态页展示连接、会话、限流、日记调度与工具策略；日志页读取环形缓冲；追踪页展示最近节点。
  - 接口：`/api/login`、`/api/config/schema`、`/api/config`、`/api/models`、`/api/status`、
    `/api/logs` 与 SSE `/api/stream`。
  - 安全：令牌或会话 Cookie 鉴权、写接口 Origin/CSRF 校验、CSP、敏感字段不回显、
    `config.json` 权限 `0600`、目录 `0700`。
- 字段注册表 `src/config/fields.ts`：默认值、zod schema、文件键集合与 JSON Schema 都由它生成。
- npm 包里带上面板前端产物（`web/dist`）：发布流程会构建前端再打包，装完打开面板就有页面，
  不需要自己跑 `bun run web:build`。

### Changed

- 日志新增 500 条环形缓冲与脱敏副本，面板可以直接读最近日志；`log.level` 保存后立即生效。
- 配置文件改为原子写并保留 `.bak`，外部改动由 `chokidar` 监听后热更新。

### Fixed

按 [docs/commit-audit-4d05341.md](docs/commit-audit-4d05341.md) 的审计结论收口：

- 面板端口被占用不再拖垮 OpenCode 进程：端口占用会重试后报错，不会变成未捕获异常。
- 面板保存配置先校验后落盘：校验不过就不碰 `config.json`；`napcat.url` 这类必填字段不允许删除，
  删了直接报 400，文件保持原样。
- 面板换过端口或地址后依然响应配置变化：配置订阅与 HTTP 监听的生命周期已拆开，
  轮换令牌、开关面板、改端口都能立刻生效。
- 面板默认关闭时，改配置打开也会启动；多余的插件实例不再提前占端口、也不留下文件监听。
- `events.subscribe` 是真的热字段：加减订阅类别不用重连。
- `reuseSession` 找回的是「上一次」的会话（最近的那条），不是「消息最多」的那条。
- 面板令牌不再明文进日志：`panel.token` 归入已知密钥，日志里显示为 `[REDACTED]`。
- 日记状态页区分「下次总结」与「下次轮询」，不再把轮询当成总结时间。

## [0.8.0] - 2026-11-11

### Fixed

- 日记只对 owner 开放：日记的采集、总结、推送、`/diary` 命令和三个日记工具都固定在 owner 自己的私聊，
  admin 与普通成员拿不到日记工具。这轮按 [docs/commit-audit-d76447b.md](docs/commit-audit-d76447b.md)
  的审计结论收口。
- 日记文件发出去之前先扫描正文：读正文前 4KB 过一遍敏感信息检查，命中就整条不发。
- 日记存储加固：日期必须合法，realpath 越界（含软链接）拒绝读写，目录 `0o700`、文件 `0o600`。
- 同一个聊天同一天并发触发总结时只写一次：总结加了互斥与去重，内容不会互相串；
  总结会话的输出缓冲也只留它自己的，其它会话的输出不会混进日记正文。
- 运行时搭建失败不再把机器级锁永久占住：启动全部成功才算完成，失败先释放锁再交给接管重试。
- 合并转发不再能伪造发送者：`qq_send_forward` 只收正文，发送者统一是机器人自己。
- 出站媒体路径按角色收窄：普通成员与主动说话只取媒体目录，owner / 管理员保持工作目录 + 媒体目录 +
  配置放开的目录。
- 回复许可不再跨轮次泄漏：新一轮开始就收回上一轮的许可与理由。
- 群昵称不能伪造角色标记：`(owner)` / `(admin)` 这类括号写法会被清掉。
- 日记素材里的结构标签（`<chat>` 及其闭合标签）先净化，伪造不出系统结构。
- 绑定的会话读不到时不再重建空会话：先在机器人工作目录里找回同一个聊天的历史会话（消息最多的那条）直接换绑，
  确实没有才新建；会话读不到时也不会先把存储里的绑定抹掉。历史会话的查找窗口从 500 条扩到 4000 条。
- 超长文本不再硬截断：素材行、日记标题与正文、日记回灌都改成在自然断点（句末、换行、逗号）截断，
  并标注「…（已截断）」。

### Changed

- 回复许可只是行为提示：工具说明与提示词里的「权限」说法改成「按约定说明本轮回复理由」，授权边界不变。
- `qq_send_forward` 的入参只保留 `content`：`user_id` / `nickname` 由插件填成机器人自己。

## [0.7.0] - 2026-11-10

### Added

- 日记：把聊天流水记成一篇篇 Markdown 日记，主人可以直接读，也能交给模型续写。
  - 日记是文件不是数据库条目，默认放在机器人工作目录的 `diary/` 下，每个聊天一个子目录，
    文件名是日期（`group-123/2026-11-10.md`）；成品不设条数上限，也不会自动清理。
  - 命令 `/diary`（TUI 侧 `/qq-diary`）：`write` 写一篇、`list` 列出最近几篇、`show` 看某天的日记、
    `auto` 立刻把今天的素材总结成一篇。
  - 工具 `qq_diary_write` / `qq_diary_read` / `qq_diary_list` 与 `qq_send_file`；
    日记以文件形式发出去，文件名形如 `日记-2026-11-10.md`。
  - 每天 `diary.summaryTime`（默认 23:30）后由调度器自动总结一篇，推送给谁由 `diary.push`
    决定（`owner` 默认 / `group` / `none`）。
  - 只对 owner 与管理员开放：成员与主动说话档在 `tool-profiles.json` 里默认 `deny` 这些工具。
  - 配置在 `diary` 一节：`path` / `enabled` / `retentionDays` / `summaryTime` / `tickSeconds` /
    `summaryTargets` / `push` / `backfill` / `backfillMax` / `maxLineChars` / `maxLinesPerDay` /
    `timeoutMs`，环境变量为 `QQ_DIARY_*`。详见 [docs/diary.md](docs/diary.md)。

## [0.6.8] - 2026-11-10

### Added

- 回复权限：默认不给模型直接发消息的权限。群里要回复用户，必须先调用
  `qq_request_reply` 说明为什么要回复，拿到权限后才能调用 `qq_send_message`；
  权限只在本轮有效，轮次结束就收回。这样模型得先想清楚该不该回复，而不是凭本能每条都回。
  私聊默认开放，不用申请；`reply.requirePermission` 可以关掉这个门槛。

### Changed

- 工具配置与会话覆盖也改放机器人工作目录（`tool-profiles.json` / `chat-overrides.json`）：
  文件不存在时把随包的同名示例复制过去，升级插件与重启都不会覆盖用户改过的内容。
  示例里的聊天号是占位，需要改成真实的群 / 私聊。
  `toolProfilesPath` / `chatOverridesPath` 的相对路径改按工作目录解析。

## [0.6.7] - 2026-11-10

### Changed

- 角色设定改放到机器人工作目录的 `souls/`：首次启动把随包分发的初始文件复制过去，
  之后只读工作目录里的副本，升级插件不再覆盖改过的设定，也不再依赖项目目录。
  `soulPath` 与聊天覆盖里的 `soul` 相对路径改按工作目录解析。
- 收发消息的日志提到 info 级：收到 QQ 消息、消息入队、投递到会话、上游仍在执行
  这些关键节点在默认日志级别下就能看到。

## [0.6.6] - 2026-11-10

### Changed

- 机器级锁改为插件初始化最开始就抢：没拿到锁的实例不注册工具、不注册钩子、也不连 NapCat，
  只保持心跳等待接管；拿到锁的实例才开始接收 QQ 消息。

## [0.6.5] - 2026-11-10

### Fixed

- 插件重复初始化导致的实例僵尸：卸载回调在初始化开始时就登记，接管方不再拿到一个
  没有清理函数的旧实例；旧实例持有的机器级锁与 NapCat 连接会被正常释放。
- QQ 工具延后到抢到机器级锁之后再注册：同一进程里加载两次插件时，没拿到锁的那份
  不再覆盖工具表，模型调到的始终是持锁、有连接的那份实现。
- 发送前检查连接与锁：没拿到机器级锁或 NapCat 没连上时，工具直接返回明确的失败
  文案，不再抛出「连接未建立，请先调用 connect()」的原始异常。
- NapCat 连接断开后自动重连一次，并记录断开、重连与恢复的日志。

## [0.6.4] - 2026-11-10

### Added

- 工具可见性排查：启动时打印注册出来的 QQ 工具名（模型按这些名字调用），每轮上下文钩子
  记录模型实际能用的 QQ 工具；看不到 `qq_send_message` 时直接告警并附上被摘掉的工具与配置档。

## [0.6.3] - 2026-11-10

### Fixed

- QQ 工具改为独立工具（`codemode: false`），不再只挂在 Code Mode 的 `execute` 下。
  普通成员的工具配置只放行 `qq_*` 时也能直接发送消息，不会因为 `execute` 被拒而整轮无法回复。
- 角色按聊天与发送者判定：轮次记录发送者 QQ 号，角色缺失时按该 QQ 号重新判定
  owner / 管理员 / 普通成员；私聊也会按对方 QQ 号还原。工具策略优先使用正在执行
  轮次的角色，不再把配置为 owner 的用户当成普通成员拒绝工具调用。

## [0.6.2] - 2026-11-10

### Changed

- 工具权限不再依赖进程内的轮次状态：只要会话仍绑定到放行的 QQ 聊天，QQ 工具就能调用；
  重启、热重载或上游续跑时模型不会因为「当前没有 QQ 消息轮次」被拒。
- 发送者角色与轮次解耦：角色按会话保留到下一轮，上下文钩子与执行前策略闸在人工驱动、
  恢复中的会话里同样按最近一轮的角色收窄工具。

### Fixed

- 重启后恢复在途轮次：正在执行的轮次（角色、是否待发送、提醒次数）会随状态落盘，
  进程重启后若上游仍在接着跑，插件会恢复这一轮的权限，模型调用 QQ 工具不会再因为
  「当前没有 QQ 消息轮次」被拒，回复不会丢掉。

## [0.6.1] - 2026-11-10

### Changed

- 轮次诊断日志：清空当前轮次统一记录原因与角色，拒绝工具调用时附带轮次状态快照；
  上下文钩子、工具策略与上游事件会按到达顺序记录。需要时用 `QQ_LOG_LEVEL=debug` 打开。

### Fixed

- 卸载时必定释放机器级锁：插件卸载的每一步单独兜底，任何一步失败（例如上游注销钩子报错）
  都不会再挡住后面的清理，断开 NapCat 与释放机器级锁一定会执行，不会留下重复投递的窗口
  和残留到过期才被接管的锁目录。
- 实例接管时交接在途状态：新实例接管旧实例时，旧实例把正在执行的一轮、排队的消息和
  冻结的失败批次一起交给新实例。旧实例在模型回复到一半时被换掉时，
  这一轮再调用发送工具不会因为「当前没有 QQ 消息轮次」被拒，回复不再丢掉。
  交接时会核对放行名单、会话是否还在、会话是否冲突；已经不在名单里的目标不接手，
  没有会话的轮次只接手排队的消息，接手的缓存消息不会在补历史时重复出现。
  正在投递的一轮会等它落地再交接，交出去的状态才接得住。
- 交接后不重复发送：接管的轮次如果旧实例已经回复过，新实例不会让模型再发一遍。
- 连续投递失败后退役会话：同一批消息重试到上限仍失败时，除了丢弃这批消息并补失败提示，
  还会把收不下消息的会话退役（打断、删掉上游会话并解绑），下一条消息新建会话并重新补历史，
  这个聊天不会再一直静默。退役有 10 分钟冷却，避免上游整体故障时反复新建会话。
- 投递失败日志带上会话 id，方便和上游日志对上。

## [0.6.0] - 2026-11-09

### Added

- 出站限流等待档（A1）：新增 `rateLimit.stall`（`QQ_RATE_STALL`，默认 `false`）与
  `rateLimit.stallMaxWaitMs`（`QQ_RATE_STALL_MAX_WAIT_MS`，默认 60000）。
  打开后，每分钟窗口满了不再直接拒绝，而是等到最早的记录滑出窗口再发；
  **只作用在每分钟窗口**：每小时上限仍然直接拒绝，不会真的睡一小时。
  等待总时长超过 `rateLimit.stallMaxWaitMs` 就放弃等待并把原因回给模型
  （说明需要等多久、允许等多久），让模型自己决定停不停。
  判定结果新增 `stalled` 字段，日志能看出这次发送是不是靠等待换来的。
- 唤醒判定增强（A2）：新增全局唤醒策略 `wake.prefixes`（`QQ_WAKE_PREFIXES`，默认 `["/"]`）、
  `wake.ignoreAtAll`（`QQ_WAKE_IGNORE_AT_ALL`，默认 `true`）、
  `wake.replyToSelf`（`QQ_WAKE_REPLY_TO_SELF`，默认 `true`）、
  `wake.ignoreAtOthers`（`QQ_WAKE_IGNORE_AT_OTHERS`，默认 `true`）。
  判定顺序：私聊必回 → 会话覆盖里写死的 `all` / `none` / `prefix` 优先 →
  被直接 @ 必回 → 群里第一个 @ 指向别人时不唤醒（并在提示词里说明"这条消息不是在跟你说话，不要回复。"）→
  全局前缀命中 → @全体成员（默认忽略）→ 回复机器人自己（默认必回）。
  每会话的 `all` / `mention` / `prefix` / `none` 覆盖保持原语义，优先级高于全局策略；
  机器人自己的消息仍然忽略。新增唤醒原因 `at_all` 与 `reply`。
- 分段回复节奏（B1）：新增 `reply.minDelayMs` / `reply.maxDelayMs`
  （`QQ_REPLY_MIN_DELAY_MS` / `QQ_REPLY_MAX_DELAY_MS`，默认都是 `0`）、
  `reply.segmentChars`（`QQ_REPLY_SEGMENT_CHARS`，默认 150）、
  `reply.forwardThresholdChars`（`QQ_REPLY_FORWARD_THRESHOLD_CHARS`，默认 1500）。
  段间隔在 `[minDelayMs, maxDelayMs]` 之间随机取值；两个都留 0 时沿用旧的 `sendDelayMs` 固定间隔。
  单条消息按 `reply.segmentChars` 切分成多段发出；超过 `reply.forwardThresholdChars`
  字的回复自动转成合并转发（复用已有的 `qq_send_forward` 通道），过长时拆成多个节点。
- 主动说话策略（B3）：新增白名单 `proactive.allowGroups` / `proactive.allowUsers`
  （`QQ_PROACTIVE_ALLOW_GROUPS` / `QQ_PROACTIVE_ALLOW_USERS`，默认空 = 不限制），
  只在这些群 / 私聊里主动开口；会话覆盖里写死 `proactive: true` 的聊天不受白名单限制。
  每会话还能单独写 `proactiveProbability`（0 到 1，写错只忽略该项并告警），
  作为该会话单次心跳的触发概率，不再随沉默时长增长；没写就沿用全局概率公式。
  沉默阈值对所有会话一视同仁。
- 调用链追踪（C1）：新增 `src/trace.ts`。一条入站消息拿一个 `trace_id`，
  事件接收 → 模型起跑 → 模型处理 → 出站回复各记一个 `span`，
  日志里带上 `trace_id` 就能把这一轮串起来。
  追踪记录按天写成 JSONL（`qq-bot-traces-YYYY-MM-DD.jsonl`），只记元数据不记消息正文；
  新增 `trace.enabled`（`QQ_TRACE_ENABLED`，默认 `true`）、`trace.dir`（`QQ_TRACE_DIR`，
  默认与日志同目录）、`trace.maxSizeMb`（`QQ_TRACE_MAX_SIZE_MB`，默认 80）、
  `trace.retentionDays`（`QQ_TRACE_RETENTION_DAYS`，默认 7），超期与超容量的旧文件会被清掉。
- 启动时第一行日志输出插件版本号，便于确认实际运行的版本。
- 准入判定（C6）：`groups` / `users` 改成 `access.allow` 与 `access.deny` 双列表
  （`QQ_ALLOW_GROUPS` / `QQ_ALLOW_USERS` / `QQ_DENY_GROUPS` / `QQ_DENY_USERS` /
  `QQ_ALLOW_ALL_WHEN_EMPTY`），判定顺序是 deny 命中拒绝 → allow 非空只放行名单 →
  否则按 `allowAllWhenEmpty`；owner 的私聊永远放行，在 deny 名单里会被豁免并告警。
  旧的 `QQ_TARGET_GROUPS` / `QQ_TARGET_USERS` 与插件选项 `groups` / `users` 已移除，
  检测到就给出迁移提示。
- 会话覆盖（C6）：新增 `chatOverridesPath` 与 `chat-overrides.json`，按群 / 私聊覆盖
  唤醒方式（`all` / `mention` / `prefix` / `none`）、是否主动说话、使用哪个 agent、
  模型与角色设定文件。唤醒结果写进提示词；agent 与模型在会话建立时生效，覆盖变化时
  对已有会话切换。文件按 mtime 热加载，缺失按默认走，单字段写错只忽略该项。
- 通知事件订阅（B7）：新增 `events.subscribe` / `events.notices` / `events.inject`
  （`QQ_EVENT_SUBSCRIBE` / `QQ_EVENT_NOTICES` / `QQ_EVENT_INJECT`），默认只订阅消息类事件。
  订阅 `notice` 后可接收撤回、进退群、管理员变动、好友新增、群文件、戳一戳与灰条消息；
  通知只写日志并缓存，不自己发起一轮，下一轮该聊天的上下文里附带摘要。
  通知同样受准入名单限制，撤回类不复述被撤回的内容。
- 模型视图里 owner / 管理员分别带 `(owner)` / `(admin)` 标记（实时消息与历史回填一致），
  发送者显示名不再附带 QQ 号。
- 工具权限（A4 / B3）：新增 `ownerQQ`、`admins`、`toolProfilesPath` 与 `tool-profiles.json`，
  按「发送者角色 + 聊天」决定模型能用哪些工具。owner 与管理员用 `admin` 档（全开），
  其他人用该群 / 私聊指定的档，未指定用 `defaultProfile`；默认档 `chat` 只放行
  `websearch`、`webfetch` 与 `qq_*`，其余（含 `shell` / `write` / 子代理）全部拒绝。
  `allow` 就是白名单，支持 `*`、`qq_*` 通配，`deny` 优先。
  限制分两层：上下文钩子删掉不允许的工具，`execute.before` 再挡一次（Code Mode、并发调用
  也绕不过）。文件按 mtime 热加载，缺失或半写时沿用内置默认 / 上一份配置并告警。
- 管理命令（B3 / B4）：同一组命令注册在 QQ 与 TUI 两边，共用 `src/commands.ts` 的命令表（TUI 侧加 `qq-` 前缀，如 `/qq-reset`）；
  QQ 侧只在 owner 与管理员自己的私聊生效，`/help`、`/status`、`/tools [目标]`，
  以及 `/reset`（不带参数列出所有聊天）/ `/reset group:123`——带目标时先打断执行中的回合，
  再删除该聊天的会话，下一条消息重开。
  群聊、其他人的私聊与未知 `/xxx` 照常交给模型。表情标注也接进同一张命令表：TUI 侧是
  `/qq-emoji-label`，QQ 私聊里是 `/emoji-label`，`/help` 自动列出。
- 失败兜底文案（B6）：回合失败或被中断且模型一句话都没发出时，往聊天里补一条固定提示
  （`⚠️ 暂时无法处理这条消息，请稍后再试。` / `⏹️ 已停止`），上游异常原文只进日志。
  同一目标 5 分钟内最多一条；模型已经发过消息、主动说话失败、以及提示发送本身失败都不补。
  同一批消息重试到上限被丢弃时也会补一条。
- 隐私扫描（`scripts/trufflehog.yml` + CI 步骤）：用 TruffleHog 自定义检测器离线扫 push / PR 带的提交
  范围，命中真实 QQ 群号、凭证赋值或 PEM 私钥即失败。CI 走官方 action 并固定 `v3.99.8`
  （`version` 也写死 `3.99.8`，它默认是 `latest`），只跑自定义检测器（`--include-detectors=CustomRegex`），
  不做联网验证。首个提交里那个已确认公开的历史群号、测试里的假凭证写进 `exclude_words`。
  本地 `bun run privacy:scan` 扫全部历史，规则与 CI 共用同一份配置。

### Fixed

- 通知里的群名片与发送者名统一走 `sanitizeSenderName()`，不再绕过入站净化。
- 调用链追踪真正执行容量上限：写满且清不出空间时丢弃新记录并告警，`prune()` 不再重复扣减
  已删除文件；追踪文件按 `0600`、目录按 `0700` 写入。
- 同一批消息里既有 @ 机器人又有「不要回复」标记时，必回意图不再被吞掉。
- 分段回复先按剩余限流额度预检，额度不够时改走合并转发，避免只发出半截消息。
- 实时入站的 owner / 管理员消息补上 `(owner)` / `(admin)` 标记，与历史回填一致。
- `/reset` 只列出并接受放行名单里的目标；`ownerQQ` 拒绝布尔值与非正整数。
- 旧配置名的迁移提示改为 `【迁移】` 前缀的 error 级启动告警。
- QQ 会话里一律拒绝创建子代理；主动说话按 `owner` 角色执行，未发送提醒沿用原轮次角色。
- 管理员的准入前提、群级配置档优先级、唤醒判定顺序、`ownerQQ` 语义等文档已修正。

## [0.5.1] - 2026-11-08

### Added

- CI（`.github/workflows/ci.yml`）：推 `main`、PR、手动触发三条入口，一个 job 里依次跑
  冻结锁文件安装 → `tsc --noEmit` → `eslint .` → `prettier --check .` → `vitest run` →
  `bun audit --production --audit-level=high`。许可证 / NOTICE 一致性由 `tests/notice.test.ts`
  一起跑。只跑 ubuntu，Windows 路径差异等真出问题再补；合成一个 job 是为了避免多个 job
  同时下载 bun 二进制被限流。
- 发布流程（`.github/workflows/release.yml` + `scripts/release-check.ts` + `docs/release.md`）：
  推 `vX.Y.Z` tag 后先做同样的门禁，通过才把包 `npm stage publish` 到暂存区并按
  CHANGELOG 对应段创建 GitHub Release。信任关系是 stage-only，维护者用 2FA 执行
  `npm stage approve` 之后版本才进入 registry。`bun run release:check` 可在本地先跑一遍：
  校验 semver、CHANGELOG 段、tag 与版本一致、LICENSE ↔ `package.json` license、
  NOTICE 覆盖全部运行时依赖、工作区干净。
- 安全文档：根目录 `SECURITY.md`（漏洞走 GitHub 私密通报，单人维护无 SLA）与
  `docs/security-baseline.md`（信任边界、数据流与不变量清单，每条带实现与测试落点）。
  `NOTICE` 增补「数据流与第三方处理」一节，写明哪些数据离开本机、落在本机哪里。
- `package.json` 新增脚本 `format:check`、`ci`、`release:check`；
  补齐 `repository` / `homepage` / `bugs`（npm `--provenance` 要求 `repository` 字段）。

### Changed

- 版本号补到 `0.5.1`。`0.4.0` / `0.5.0` 只改了版本号与 CHANGELOG，没有发布到 npm，
  这次把它们的全部改动一起带出去，`0.5.1` 是 npm 上第一个包含这些内容的版本。

## [0.5.0] - 2026-11-08

### Added

- 出站敏感信息拦截（`src/sensitive.ts`）：发给 QQ 的消息在发送前统一检查，命中凭证就整条不发。
  检测用 [`flare-redact`](https://github.com/flare-collection/flare-redact)（MIT、零运行时依赖、同步 `scan()`），
  取它的默认检测器并去掉 `email` / `obfuscated_email` / `credit_card` / `iban`——只拦凭证，不拦群聊里正常的邮箱、手机号、QQ 号。
  在此基础上补了四件事：环境变量里名字像密钥的值与 `napcat.token` 编译成已知凭证检测器（被空格 / 换行拆开时按 12 字符分片比对）；
  NFKC + 零宽字符归一化（`ｐａｓｓｗｏｒｄ＝…`、`pass\u200bword=…` 也能命中）；解码文本里的 base64 / base64url 片段后再扫一遍；
  拦截 `.ssh` / `.aws` / `.env` / `id_rsa` 这类凭证文件路径。
  检查覆盖 `send_message`、`send_image`、`send_record`、`send_sticker`、`send_forward`，在拆段之前做，超长消息只要有一段命中整条都不发。
  命中时工具返回错误，模型可以删掉凭证后重发；本轮不算已回复，也不会触发补发提醒。
  已识别的凭证不会出现在日志与错误说明里，只记录命中的检测器名称。
  新增配置项 `sensitive.enabled`（`QQ_SENSITIVE_ENABLED`），默认开启。
- 入站图片下载的 SSRF 加固（`src/safe-fetch.ts`）：下载地址由群友控制，只做字符串匹配挡不住 DNS 重绑定。
  现在改成在连接层判定——先解析 DNS，解析出的每一个地址都要过公网判定（回环、私网、CGNAT `100.64/10`、
  `198.18/15`、IPv4-mapped、NAT64、6to4、链路本地、组播、元地址一律拒绝），判定通过才连过去，
  连的就是刚判定过的地址，Host 与 SNI 保持原样；端口只放行 `80` / `443` / `8080` / `8443`，
  3xx 不跟随（算失败），免得用跳转绕过判定。
  判定用现成的 [`request-filtering-agent`](https://github.com/azu/request-filtering-agent)，
  原先的 `isPrivateHost` 字符串判定删除。
- 出站限流：出站消息按目标（群 / 私聊）单独计数，模型一轮连发不再把群刷爆，也降低平台风控风险。
  每分钟最多 `rateLimit.maxPerMinute` 条（默认 8）、每小时最多 `rateLimit.maxPerHour` 条（默认 60），
  超出则拒绝这次发送并把原因回给模型（说明里写明请停止发送并结束本轮），本轮同样算已回复，
  不会再触发补发提醒。相邻两次发送至少隔 `rateLimit.minGapMs` 毫秒（默认 1500），间隔不足先等一等，不丢消息。
  计数按目标分开；超长消息拆出的每一段都算一条，同一段消息内部的多段共用一个操作 id，
  段与段之间只按 `sendDelayMs` 等待，不叠加限流间隔。主动说话走同一条路径，同样受限流约束。
  插件自己生成的消息（`/emoji-label` 的结果与进度）走另一个计数域，不占用模型回复的额度。
  三个值都为 `0` 表示不限制；计数只存在内存里，插件重启后重新开始。
  新增配置项 `rateLimit.maxPerMinute`（`QQ_RATE_MAX_PER_MINUTE`）、`rateLimit.maxPerHour`（`QQ_RATE_MAX_PER_HOUR`）、
  `rateLimit.minGapMs`（`QQ_RATE_MIN_GAP_MS`）。
- 入站模型视图（`src/model-view.ts`）：群友可控的文本进模型前先做结构净化——换行折成空格、
  零宽字符清掉、全角方括号换半角，`<quote>` / `<forward>` / `<history>` 这类结构标签换成全角，
  群里伪造不出系统段落；净化覆盖正文、引用块、合并转发节点、语音转写、文件名和群名片。
  整条消息拼好之后还会整体净化一次，结构标签拆成两段发过来同样伪造不出来；
  插件自己展开的结构块用占位符保护，净化之后才还原。
  每条消息标上绝对时间，消息行变成 `[YY-MM-DD HH:MM] 名字(QQ号): 正文`，
  名字后的括号里是发送者 QQ 号，用来区分同名的人。同一批里重复投递的同一条消息只留一份。
- 冷启动补历史：新建会话或重启后恢复会话时，把最近的历史消息以 `<history>` 文本块拼进首轮提示。
  新建会话补最近 `history.count` 条（默认 20）；重启恢复时从上次投递到的位置之后补增量，
  补增量时按 NapCat 的历史接口方向往更早的时间翻页。
  历史里的图片会下载进会话、语音会转写，群公告 / 成员变动等非消息事件不补。
  新增配置项 `history.count`（`QQ_HISTORY_COUNT`），`0` 表示关闭。
- 保活心跳：OpenCode 按 location 统计会话活动，默认空闲 60 分钟后卸载该 location 的服务，
  插件随之被卸载，NapCat 连接断开后机器人不再响应。插件现在每隔 `keepAlive.seconds`
  （默认 1200 秒）原样写回一次会话元数据，产生一条带 location 的 durable 会话事件，
  把空闲计时重置。心跳跑在一个不绑定 QQ 目标的专用会话上（标题 `QQ 保活`），
  不影响群聊会话，也不消耗模型调用。插件卸载时删掉这个专用会话，不在项目目录里留垃圾；
  取得会话时请求归档，让它不出现在会话列表里（上游插件接口目前忽略归档请求，
  支持之前它仍会显示，插件会在日志里说明）。新增配置项 `keepAlive.enabled`
  （`QQ_KEEP_ALIVE_ENABLED`）与 `keepAlive.seconds`（`QQ_KEEP_ALIVE_SECONDS`）。
  推荐同时在 `opencode.json(c)` 里设置 `experimental.location_idle_timeout: false`，
  彻底关掉 OpenCode 的自动卸载；插件卸载时的日志也会提示这一项。
- 固定机器人工作目录：新增配置项 `home`（`QQ_BOT_HOME`），未配置时使用
  `$XDG_DATA_HOME/opencode-qq-bot/workspace`（默认 `~/.local/share/...`），启动时自动创建。
  群聊/私聊会话都在该目录创建（`session.create` 显式传 `location`），历史会话也按该目录查找，
  不再跟随加载插件的项目目录。
- 日志落盘与逐行脱敏（`src/logger.ts`）：日志改用 [Winston](https://github.com/winstonjs/winston)，
  console 保留人类可读格式（`[时间] 级别 前缀 正文`），同时用
  [`winston-daily-rotate-file`](https://github.com/winstonjs/winston-daily-rotate-file) 写一份
  一行一条 JSON 的日志文件：`qq-bot-YYYY-MM-DD.log` 按天滚动，超过 `log.maxSize`（默认 `5m`）再切一份，
  历史最多保留 `log.maxFiles`（默认 5）份。目录默认 `$XDG_STATE_HOME/opencode-qq-bot/logs`
  （未设置则 `~/.local/state/opencode-qq-bot/logs`），不存在时自动创建。
  写盘前对最终序列化后的整行做一次脱敏，用的是出站拦截那套检测器
  （`src/sensitive.ts` 新增 `maskSecrets()`）：识别到的凭证替换成 `[REDACTED:<检测器>]`，
  `message`、`meta` 与 Error stack 全部覆盖。日志场景是打码不是拦截——
  普通中文聊天、QQ 号、手机号、邮箱、URL、UUID 原样保留。
  插件卸载时等文件流落盘，避免丢掉最后几行。
  新增配置项 `log.level`（`QQ_LOG_LEVEL`）、`log.dir`（`QQ_LOG_DIR`）、
  `log.maxSize`（`QQ_LOG_MAX_SIZE`）、`log.maxFiles`（`QQ_LOG_MAX_FILES`）。
- 出站媒体路径白名单（`src/media-path.ts`）：`qq_send_image` / `qq_send_record` 的 `file`
  以前直接透传给 NapCat，插件进程能读到的文件模型都能发进群。现在本地路径只允许机器人工作目录、
  媒体目录和 `media.allowedDirs`（`QQ_MEDIA_ALLOWED_DIRS`）放开的目录；判定时展开 `~`、
  相对路径按工作目录解析、再取真实路径比较，目录内的软链接指向目录外同样拒绝，目录按边界比较
  （`/data/qq-bot` 不会命中 `/data/qq-bot-secret`），必须是存在的普通文件。
  http(s) 地址改为先预检再交给 NapCat：协议与端口要在白名单里，域名解析出的每个地址都必须是公网
  （用 `ipaddr.js`，与 `request-filtering-agent` 同一套规则），通过后地址原样给 NapCat 自己去下载，
  插件不碰文件，NapCat 与插件不必共享文件系统。已知局限是 DNS 重绑定窗口：预检解析一次，
  NapCat 下载时再解析一次，挡得住地址本身指向内网，挡不住先给公网 IP 后解析到内网。
  路径判定在发送额度之前，不合法的路径不占额度，模型可以立刻重发。
  媒体目录同时从 `/tmp/opencode-qq-bot-media` 迁到 `$XDG_STATE_HOME/opencode-qq-bot/media`
  （未设置时 `~/.local/state/opencode-qq-bot/media`），与日志目录一致。

### Changed

- 出站文本质量：模型回复里的 markdown 会先剥成纯文本再发出去（`remove-markdown`）——
  标题、强调、代码围栏、HTML 标签去掉，列表符号去掉只留正文，首尾带竖线的表格整块丢弃，
  链接与图片保留 URL（`文档: https://...`）。超长消息改用 `Intl.Segmenter`
  按字素簇切分，不再切坏 ZWJ emoji 序列、肤色修饰符、区域指示符旗帜和组合字符。
  只作用于模型产出的文本（`qq_send_message` 的 content 与 `qq_send_forward` 的节点文本），
  插件自己生成的提示文本保持原样。
- `warnLength` 默认值从 `20` 改成 `500`：原值下几乎每条回复都会告警，告警因此失去意义。
  判定口径是单次发送的内容长度，只告警，不截断也不影响发送。
- 单实例范围从「同一个机器人」扩到「整台机器」：锁路径不再按 NapCat 端点与令牌派生，
  改为机器级固定路径；进程内注册表也只在同一工作目录的实例之间交接。

### Fixed

- 群友把结构标签拆成两段发过来就能伪造 `<quote>` / `<forward>` / `<history>`：
  净化原本逐个消息段进行，`<` 与 `quote>` 分处两段时匹配不到，拼起来仍是一个标签。
  现在整条消息拼好之后整体净化一次，插件自己展开的结构块用占位符保护，净化之后才还原。
- 补历史的翻页方向错了：NapCat 的历史接口不传 `reverse_order` 就是往当前时间取，
  翻页拿回来的还是最新那几条，去重后增量恒为空，最后退化成把最近 N 条重复注入上下文。
  现在补增量时传 `reverse_order: true`，往更早的方向翻页。
- 表格后面的正文被整段吞掉：删表格时只要下一行含 `|` 就当表格行继续吞，
  正文里的一个竖线能让整条消息消失。现在只有首尾带竖线、列数与表头一致的行才算表格行。
- 拆行时首部的空行被吞掉：`splitMessage` 用长度判断要不要换行，空行长度为 0 就被丢掉，
  与「保留原有换行与空行」不符。现在按行数记账，首部空行保留。
- NOTICE 的许可清单与实际不符：写着每个依赖都自带许可文本，实际 `@opencode/plugin` 与
  `@opencode/schema` 没有许可文件（`package.json` 标注 MIT），而且 `@opencode/schema`
  整个漏在清单外。现在补齐依赖清单并说明差异。
- 补历史失败一次就永久不再补：失败也会把「已经补过」置位，该目标这一轮再也回填不了历史。
  现在补成功才算补过，失败下一轮重试。
- `restoredPositions` 是启动时的位置快照，投递成功后却会被就地改写，
  `since` 的取值语义和注释不符。现在只更新 `positions`，快照保持启动时的值。
- `warnLength` 的长度口径和拆段不一致：告警按 UTF-16 码元算，拆段按字素簇算，
  一个 emoji 记两个码元，阈值实际偏严。现在两边都按字素簇算。
- 只含 QQ 官方表情（`face`）的消息、只含 `at` 的消息被整条丢弃：门卫只放行
  `text` / `image` / `record` / `forward` / `reply`，其余段类型即使渲染器支持也会被挡掉。
  现在门卫按"渲染器能产出文本的段类型"放行，`video` / `audio` / `file` / `json` /
  `xml` / `markdown` 同样不再被丢。
- `.env.example` 仍列着 0.3.2 已移除的 `QQ_BUSY_TIMEOUT_MS`，并把默认角色设定写成包内
  `SOUL.txt`（实际是 `souls/default.txt`）；同时补上漏掉的 `QQ_BOT_SOUL_NAME`。
- README 里 `warnLength` 的说明写成「一轮回复总长度」，与实现（单次发送的内容长度）不符。
- data URL 图片改为按魔数判定类型，不再信任 URI 里声明的 MIME；无法识别时跳过并告警。
- 每条 QQ 消息只水合一次媒体：删除插件入口里重复的 `hydrate` 调用，渲染阶段已经补全直链。
- `question` 工具只在 QQ 轮次执行期间拦截：人工在 TUI 里驱动同一个会话时不再被误拦。
- 连续调用发送工具会被拒绝：发送类工具之后必须先调用任意其它工具才能再次发送，
  避免同一条消息被重复发出；发送失败时允许立即重试。
- 收藏表情的摘要与标签是表情主人写的内容，却原样进了提示词：现在和群消息正文一样
  先做结构净化，伪造不出 `<quote>` / `<forward>` / `<history>` 这类系统段落。
- 投递失败的一批消息没有重试上限：上游永久拒绝该批内容时，这个目标从此不再响应。
  现在这一批最多投递 3 次，仍失败就丢弃并记错误日志，缓冲里的新消息照常投递。
- 表情标签只取模型回复的最后一段：模型分多段输出时标签会残缺。现在把各段按顺序拼起来，
  等这一轮执行结束再清洗；执行失败或被中断时不取这一轮的文本。
- 插件卸载后标注任务还在后台继续跑，会继续消耗模型额度：现在卸载即中止，不再发起
  新的标注请求，也不写回标签。
- 收藏表情编号索引读取失败后不再重试：一次临时存储读取失败就让索引长期为空，编号从 1
  重新分配。现在读取失败会在下次调用时重试。
- 收藏表情列表的 `refresh` 在有请求进行中被忽略，刷新拿到的还是旧数据：现在等在途请求
  结束后重新拉取。
- 上游的结束事件丢失时，缓存的消息会一直压着，直到下一条消息进来才投出去。现在缓存里
  还有消息时按 30s 间隔兜底轮询上游会话状态，确认空闲就把消息投出去；消息全部投完后
  轮询自动停止，不会空转。
- 审计后续修复：`closeLogger` 只关闭传入的日志器，接管实例时新日志器不再被旧实例关掉；
  补历史接口失败会向上抛错，只有真正成功才置位 `historyDone`；发送工具返回 error 文本时
  也会撤销连续发送标记（完全没发出去才允许重试，部分发送与限流拒绝保持已发送）；
  `send_forward` 的昵称也做凭证扫描。
- 日志打码会先检查 NFKC / 零宽归一化后的文本，混淆凭证整行丢弃；`XDG_STATE_HOME` 只接受绝对路径。
- 入站 HTTP 图片统一按魔数判定类型，不再信任声明类型；收藏表情的并发非刷新请求复用同一在途结果；
  表情标签会话固定到机器人工作目录，并忽略别的工作目录留下的会话。
- 删除已无调用的 `hydrateMedia`；补历史超过 10 页时记录告警。

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

- 忙碌期间收到的消息迟迟不处理：插件靠 `session.idle` 判断一轮结束，但 2.2.5 实际只在执行结束时
  发送 `session.execution.succeeded`，`session.idle` 收不到，事件不会到达，只能等
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
