# Changelog

本文件记录 opencode-qq-bot 的重要变更。

## [Unreleased]

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

### Changed

- 许可证统一为 GPL-3.0-or-later：`package.json` 原先声明的是 `MIT`。
- 真实群号不再提交：`opencode.json` 改为本地配置并被 `.gitignore` 忽略，
  仓库只保留 `opencode.example.json` 模板。

## [0.1.0] - 2026-11-04

### Added

- 首个版本：NapLink（OneBot 11）接入 OpenCode V2 插件。
- 群消息 → OpenCode 会话 → `qq_*` 工具回复到群。
- 会话忙碌时缓存消息、空闲后合并成一轮。
- 语音转写、图片内联、引用与合并转发展开。
- 角色设定 `SOUL.txt`、系统提示注入、主动说话心跳、发送工具漏调用提醒。
