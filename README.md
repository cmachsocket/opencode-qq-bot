# opencode-qq-bot

把 QQ 群聊和私聊接进 OpenCode V2 的插件。通过 [NapLink](https://www.npmjs.com/package/@naplink/naplink) 连 NapCat（OneBot 11），
每个群聊或私聊对应一个 OpenCode 会话，模型用 `qq_*` 工具把回复发回聊天。

- 群聊 / 私聊消息 → OpenCode 会话 → 模型回复 → 对应聊天
- 每个聊天固定对应一个会话，会话忙碌时新消息先缓存，空闲后合并成一轮再投进去；绑定写入插件存储，重启后自动沿用原会话
- 语音自动转写、图片落盘后以文件引用进入会话、引用与合并转发展开成文本块
- 群消息进会话前先做结构净化并标上绝对时间，群里伪造不出系统段落
- 新建会话或重启恢复时，把最近的历史消息拼进首轮提示，模型不至于对之前聊过什么一无所知
- 收藏表情（表情包）可以用 `/emoji-label` 生成中文标签，模型按收藏表情编号把表情发回聊天
- 角色设定放在 `souls/` 目录，可放多份，按文件名切换，改动后下一轮立即生效

## 环境要求

- OpenCode V2（服务端插件 API）
- NapCat 已启动并开放正向 WebSocket
- bun（依赖与脚本）

## 安装

```sh
bun install
```

在 `opencode.json(c)` 里加载插件：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  // 长时间没有会话活动时 OpenCode 会卸载插件，设为 false 就不再自动卸载
  "experimental": {
    "location_idle_timeout": false,
  },
  "plugins": [
    {
      "package": "./",
      "options": {
        // 不配置或留空数组时，对应的群聊或私聊不响应
        "napcat": {
          "url": "ws://127.0.0.1:3001",
          "token": "your-token",
        },
        "groups": [123456789],
        "users": [987654321],
      },
    },
  ],
}
```

`package` 可以是本地路径，也可以是发布到 npm 的包名。

## 配置

插件选项优先于环境变量，环境变量优先于默认值。

**凭证不写进仓库**：把 NapCat 地址、令牌和真实群号/QQ 号写进本地 `opencode.json` 的插件
`options`，该文件已被 `.gitignore` 忽略；仓库只保留 `opencode.example.json` 模板。

插件不会读取项目 `.env`。如果选择用环境变量配置，必须把变量注入 OpenCode 服务进程本身，
可参考 `.env.example`；`cp .env.example .env` 不会生效。

| 选项                                | 环境变量                        | 默认值        | 说明                                            |
| ----------------------------------- | ------------------------------- | ------------- | ----------------------------------------------- |
| `napcat.url`                        | `NAPCAT_WS_URL`                 | 无（必填）    | NapCat 正向 WebSocket 地址                      |
| `napcat.token`                      | `NAPCAT_WS_TOKEN`               | 无            | NapCat 访问令牌                                 |
| `groups`                            | `QQ_TARGET_GROUPS`              | `[]`          | 参与对话的群号，逗号分隔                        |
| `users`                             | `QQ_TARGET_USERS`               | `[]`          | 参与对话的私聊 QQ 号，逗号分隔                  |
| `soulPath`                          | `QQ_BOT_SOUL_PATH`              | 包内 `souls/` | 角色设定文件或目录路径                          |
| `soulName`                          | `QQ_BOT_SOUL_NAME`              | `default.txt` | `souls` 目录里的角色设定文件名                  |
| `home`                              | `QQ_BOT_HOME`                   | XDG 工作区    | 机器人会话的工作目录，必须是绝对路径或 `~/`     |
| `agent`                             | `QQ_BOT_AGENT`                  | OpenCode 默认 | 会话使用的 agent                                |
| `model`                             | `QQ_BOT_MODEL`                  | OpenCode 默认 | 会话使用的模型，格式 `provider/model[/variant]` |
| `sendDelayMs`                       | `QQ_SEND_DELAY_MS`              | `1000`        | 超长消息分段发送时每段之间的间隔                |
| `warnLength`                        | `QQ_WARN_LENGTH`                | `500`         | 单次发送的内容长度超过该值时告警                |
| `reuseSession`                      | `QQ_REUSE_SESSION`              | `false`       | 没有保存的绑定时，按会话标记找回上一次的会话    |
| `proactive.enabled`                 | `QQ_PROACTIVE_ENABLED`          | `true`        | 是否启用主动说话                                |
| `proactive.silenceThresholdSeconds` | `QQ_PROACTIVE_SILENCE_SECONDS`  | `10800`       | 沉默多久后才开始计算主动说话概率                |
| `proactive.startProbability`        | `QQ_PROACTIVE_P_START`          | `0.01`        | 刚跨过阈值时的概率                              |
| `proactive.probabilityPerHour`      | `QQ_PROACTIVE_P_SLOPE_PER_HOUR` | `0.05`        | 每多沉默一小时概率的增量                        |
| `proactive.tickSeconds`             | `QQ_PROACTIVE_TICK_SECONDS`     | `3600`        | 心跳间隔，必须大于 0                            |
| `reminder.enabled`                  | `QQ_REMINDER_ENABLED`           | `true`        | 模型一轮没调用发送工具时是否提醒                |
| `reminder.max`                      | `QQ_REMINDER_MAX`               | `2`           | 连续提醒次数上限                                |
| `keepAlive.enabled`                 | `QQ_KEEP_ALIVE_ENABLED`         | `true`        | 是否启用保活心跳                                |
| `keepAlive.seconds`                 | `QQ_KEEP_ALIVE_SECONDS`         | `1200`        | 保活心跳间隔（秒），必须大于 0                  |
| `history.count`                     | `QQ_HISTORY_COUNT`              | `20`          | 新建或恢复会话时补多少条历史，`0` 表示关闭      |
| `rateLimit.maxPerMinute`            | `QQ_RATE_MAX_PER_MINUTE`        | `8`           | 每分钟最多发多少条消息，`0` 表示不限制          |
| `rateLimit.maxPerHour`              | `QQ_RATE_MAX_PER_HOUR`          | `60`          | 每小时最多发多少条消息，`0` 表示不限制          |
| `rateLimit.minGapMs`                | `QQ_RATE_MIN_GAP_MS`            | `1500`        | 相邻两次发送之间的最小间隔（毫秒）              |
| `sensitive.enabled`                 | `QQ_SENSITIVE_ENABLED`          | `true`        | 拦截含凭证、令牌、私钥的出站消息                |
| `log.level`                         | `QQ_LOG_LEVEL`                  | `info`        | 日志级别：`debug` / `info` / `warn` / `error`   |
| `log.dir`                           | `QQ_LOG_DIR`                    | XDG 日志目录  | 日志文件目录，不存在时自动创建                  |
| `log.maxSize`                       | `QQ_LOG_MAX_SIZE`               | `5m`          | 单个日志文件的大小上限                          |
| `log.maxFiles`                      | `QQ_LOG_MAX_FILES`              | `5`           | 保留多少个历史日志文件                          |

没配置 `groups` 和 `users` 时插件不会响应任何消息（默认全部关闭）。

`home` 未配置时固定使用 `$XDG_DATA_HOME/opencode-qq-bot/workspace`（默认
`~/.local/share/opencode-qq-bot/workspace`），启动时自动创建。会话的 cwd、文件工具、
`AGENTS.md` 和 git 都取这个目录，不再跟随加载插件的项目目录。

`log.dir` 未配置时使用 `$XDG_STATE_HOME/opencode-qq-bot/logs`（默认
`~/.local/state/opencode-qq-bot/logs`），启动时自动创建。日志按天滚动成
`qq-bot-YYYY-MM-DD.log`，每行一条 JSON，写盘前统一脱敏：识别到的凭证会变成
`[REDACTED:<检测器>]`，普通聊天内容原样保留。

布尔环境变量接受 `true/false`、`1/0`、`yes/no`、`on/off`；数值直接写数字。
写错的配置项会输出告警并回退到默认值，不会静默失效。
取值规则与图片内联限制见 [docs/configuration.md](docs/configuration.md)。

### 保活

OpenCode 按 location 统计会话活动，默认空闲 60 分钟后卸载该 location 的服务，
插件随之被卸载，NapCat 连接断开后机器人就不再响应。

根治办法是在 `opencode.json(c)` 里关闭这个超时：

```jsonc
{
  "experimental": {
    "location_idle_timeout": false,
  },
}
```

插件自身还有一层保活心跳（`keepAlive`）：每隔 `keepAlive.seconds` 秒原样写回一次会话元数据，
产生一条带 location 的 durable 会话事件，把空闲计时重置。心跳跑在一个不绑定 QQ 目标的
专用会话上（标题 `QQ 保活`），不影响群聊会话，也不消耗模型调用。
插件卸载时会删掉这个专用会话，不会在项目目录里留下垃圾；取得会话时也会请求归档，
让它不出现在会话列表里——上游插件接口目前忽略归档请求，在它支持之前该会话仍会显示。

### 角色设定

角色设定文件放在 `souls/` 目录，一个目录里可以放多份，用 `soulName` 选生效的那份：

```
souls/
  default.txt     默认角色
  白羽桃.txt      另一份角色
```

```jsonc
{
  "plugins": [
    {
      "package": "./",
      "options": {
        "soulName": "白羽桃.txt",
      },
    },
  ],
}
```

- `soulName` 填 `souls` 目录里的文件名，默认 `default.txt`。
- `soulPath` 可以直接给文件路径（相对路径按进程工作目录解析），也可以给目录，目录时同样用 `soulName` 选文件。
- 生效文件的内容改动会被监听，下一轮就用新设定，不需要重启插件。
- 改 `soulName` 换角色：写进 `opencode.json(c)` 保存后 OpenCode 会重载插件，随即生效。

## 工具

模型只能操作当前会话绑定的群聊或私聊，工具都带 `qq_` 前缀：

| 工具                       | 说明                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `qq_send_message`          | 发消息。`content` 文本，`reply=false` 表示已读不回，`unlimit_length=true` 解除长度告警      |
| `qq_send_image`            | 发图片，`file` 传路径或 URL，`base64` 传 `base64://` 数据                                   |
| `qq_send_record`           | 发语音                                                                                      |
| `qq_send_sticker`          | 发收藏表情（表情包），`id` 填收藏表情编号，编号见 `qq_favorite_list` 或 `/emoji-label list` |
| `qq_favorite_list`         | 列收藏表情（表情包）的编号与标签                                                            |
| `qq_send_forward`          | 发合并转发，`nodes` 为节点列表                                                              |
| `qq_send_poke`             | 戳一戳                                                                                      |
| `qq_delete_message`        | 撤回机器人自己发送过的消息                                                                  |
| `qq_get_group_member_info` | 查用户资料：群聊返回群名片与昵称，私聊返回昵称                                              |
| `qq_fetch_ptt_text`        | 转写当前聊天最近收到的语音                                                                  |
| `qq_get_login_info`        | 机器人自己的 QQ 号与昵称                                                                    |

发送类工具（消息、图片、语音、收藏表情、转发、戳一戳）成功后都算本轮已回复，不会再触发补发提醒。
连续调用发送类工具会被拒绝，避免把同一条消息发两遍；中间调用任意其它工具后即可再次发送。
工具只在当前聊天配置仍启用、且会话正处理 QQ 消息轮次时可用。

### 出站限流

模型在一轮里可以连着发好几条消息，插件对出站消息按目标计数并限速：

| 限制                           | 默认值 | 超出后的行为                     |
| ------------------------------ | ------ | -------------------------------- |
| 每分钟最多 `maxPerMinute` 条   | `8`    | 拒绝这次发送，模型收到错误并停手 |
| 每小时最多 `maxPerHour` 条     | `60`   | 同上                             |
| 相邻两次至少隔 `minGapMs` 毫秒 | `1500` | 先等一等再发，不丢消息           |

- 计数按目标（群 / 私聊）分开算，一个群刷屏不会影响别的群。
- 超长消息拆出的每一段都算一条；同一段消息内部的间隔由 `sendDelayMs` 控制，不再叠加等待。
- 被限流拒绝时本轮同样算已回复，不会再提醒模型补发。
- `rateLimit.maxPerMinute` / `maxPerHour` / `minGapMs` 设为 `0` 表示不限制。
- 插件自己生成的消息（`/emoji-label` 的结果与进度）单独计数，不会占用模型回复的额度。

### 出站敏感信息拦截

发给 QQ 的消息在发送前会扫一遍，命中凭证就整条拦下（`sensitive.enabled`，默认开启）：

- 各家 API key、JWT、`Authorization: Bearer …`、PEM 私钥、`password=…` / `密码：…` 这类凭证赋值。
- 环境变量里名字像密钥的值与 `napcat.token`：被空格或换行拆开、用全角 / 零宽字符混淆、或做了 base64 编码也能认出来。
- `.ssh/id_rsa`、`~/.aws/credentials`、`.env` 这类凭证文件路径。

只拦凭证，不拦邮箱、手机号、QQ 号这类群聊里正常出现的内容。命中时工具返回错误，模型可以删掉凭证后重发；
本轮不算已回复，也不会触发补发提醒。细节见 [docs/configuration.md](docs/configuration.md#出站敏感信息拦截)。

## 收藏表情（表情包）

给 QQ 收藏表情起中文标签，之后模型按**编号**把表情发回聊天。

```
/emoji-label all     重新标注全部收藏表情
/emoji-label inc     只标注还没有标签的收藏表情
/emoji-label list    列出收藏表情的编号与标签
```

- 命令没有 TUI 回显，结果全部通过 QQ 消息发出（会话没绑定目标时发给第一个配置目标）。
- 编号只是发图片的句柄，由插件自己维护（从 1 开始，保存在插件存储里）；身份依据是图片 `md5`，和 NapCat 的 `emo_id` / `res_id` 解耦。模型用 `qq_send_sticker` 的 `id` 参数按编号发送，不做标签模糊匹配。
- 标签由模型看图生成：清洗后是 12 个字以内、不带标点的中文短语，例如「猫猫摊手」。
- 标签写在 NapCat 侧的 `desc` 字段里，插件不保存副本。
- 标注在一个不绑定 QQ 目标的专用会话里跑，不会触发「必须调用 `qq_send_message`」的角色守则。

详细说明见 [docs/emoji.md](docs/emoji.md)。

## 扩展能力（可选）：SnowLuma MCP

`qq_*` 只覆盖对话必需的几个动作。群资料、成员管理、消息记录等其余 OneBot 动作可以交给
[@snowluma/mcp](https://www.npmjs.com/package/@snowluma/mcp)，插件不依赖它，也不自动加载，
需要你在 `opencode.json(c)` 里自行配置：

```jsonc
{
  "mcp": {
    "snowluma": {
      "type": "local",
      "command": ["npx", "-y", "@snowluma/mcp"],
      "enabled": true,
      "environment": {
        // OneBot HTTP 接口，不是插件使用的 WebSocket 地址
        "SNOWLUMA_MCP_ENDPOINT": "http://127.0.0.1:3000/",
        "SNOWLUMA_MCP_TOKEN": "",
        // 尽量保持 read 模式，避免模型绕过聊天绑定直接发消息
        "SNOWLUMA_MCP_MODE": "read",
      },
    },
  },
}
```

- `read` 模式只暴露只读动作，`invoke_action` 不会注册；改成 `write` 后模型可以调用任意动作，
  届时它可能绕过聊天绑定和 `qq_*` 的发送记账直接发消息。
- `SNOWLUMA_MCP_ENDPOINT` 指向 NapCat 的 HTTP 接口，需要在 NapCat 里一并开启 HTTP 服务。
- [@snowluma/mcp](https://www.npmjs.com/package/@snowluma/mcp) 采用源码可见的非商业许可，
  本项目不分发、也不打包它，安装与许可合规由使用者自行负责。

## 行为

- **回复是强制的**：系统提示要求模型每轮至少调用一个发送类工具，直接输出的文字会被丢弃。
- **被 @ 才必须回**：群里没被 @ 时模型可以调用 `qq_send_message` 并设 `reply=false` 选择已读不回；私聊消息必须回复。
- **消息合并**：会话正在跑模型时新到的消息进缓存，会话空闲后合并成一轮再投进去。
- **顺序处理**：同一聊天的消息按到达顺序完成渲染和入队，不会因图片下载或成员查询而乱序。
- **单实例消费**：同一台机器上只允许一个插件实例连接 NapCat 接收消息，其余实例不连接并
  等待接管，避免同一条 QQ 消息被重复投递给模型。锁是机器级固定路径的文件锁，不区分机器人
  身份，基于文件系统实现，Windows、macOS、Linux 行为一致。群聊与私聊会话的工作目录取
  `home`（默认 XDG 工作区），与加载插件的项目目录无关，历史会话也按该目录查找。
- **异常恢复**：模型失败、中断或长时间无响应时会释放忙碌状态并放行缓存消息。
- **保活**：默认每 20 分钟写回一次会话元数据，OpenCode 不会因为长时间没有会话活动而卸载插件。
- **提醒**：模型一轮完全没调用任何发送工具时，插件会补一条合成消息提醒它，最多 `reminder.max` 次，
  每个新的用户轮次都会重新给一份预算。
- **主动说话**：聊天沉默超过阈值后按每小时概率发起话题，重启后静默时长会继续累计。
- **图片**：远端图片下载到受控临时目录后以 `file:` 引用进入提示，单张不超过 5MB、
  单轮最多 8 张、总量不超过 16MB，超出的图片只保留 `[图片]` 占位文本。
  临时文件默认保留 7 天，插件会定期清理过期文件。
  下载只走公网地址：解析出的 IP 逐个判定，回环、私网、CGNAT、IPv4-mapped 等内网地址一律拒绝，
  端口只放行 80 / 443 / 8080 / 8443，也不跟随跳转。
- **出站文本**：模型写的 markdown 会先剥成纯文本再发出去——标题、强调、代码围栏去掉，
  列表符号去掉只留正文，首尾带竖线的 markdown 表格整块丢弃，链接与图片保留 URL；
  超长消息按字素簇切分，不会把 emoji 序列、肤色修饰符或组合字符切坏。
  插件自己生成的提示文本不做剥离。
- **入站净化**：群友可控的文本（正文、引用、转发、语音转写、文件名、群名片）进模型前先净化——
  换行压成空格、零宽字符清掉、全角方括号换半角，`<history>` / `<quote>` / `<forward>` 这类结构标签
  换成全角，群里伪造不出系统段落；每条消息标上绝对时间 `[YY-MM-DD HH:MM] 名字(QQ号): 正文`，
  括号里的 QQ 号用来区分同名的人。整条消息拼好之后还会整体净化一次，
  标签拆成两段发过来同样伪造不出来。

## 开发

```sh
bun install
bun run typecheck   # tsc --noEmit
bun run lint        # eslint .
bun run test        # vitest run
bun run format      # prettier --write .
```

## 目录

```
souls/               角色设定文件（可多份，按文件名切换）
src/
  config.ts          配置合并与校验
  home.ts            机器人固定工作目录（配置或 XDG 工作区）
  index.ts           插件入口
  instance.ts        插件重载时的实例接管
  keepalive.ts       location 保活心跳
  logger.ts          日志
  model-view.ts      入站模型视图：文本净化、绝对时间标注
  emoji/command.ts   /emoji-label 命令
  emoji/faces.ts     QQ 官方表情 ID → 名称
  emoji/favorites.ts 收藏表情读写与编号格式化
  emoji/favorite-index.ts 插件自维护的收藏表情编号索引
  emoji/label.ts     用模型给收藏表情起标签
  naplink/client.ts  NapLink 连接与 API 门面
  naplink/history.ts 冷启动 / 重启恢复时补齐历史消息
  naplink/render.ts  消息段 → 文本与图片附件
  outbound.ts        出站文本：markdown → 纯文本、字素簇安全切分
  sensitive.ts       出站敏感信息检查：凭证、令牌、凭证路径
  session/prompt.ts  固定守则与系统提示
  session/soul.ts    角色设定定位、读取与热更新
  session/manager.ts 群聊 / 私聊 ↔ 会话映射、消息缓存
  tools/ask-guard.ts 拦截内置 question 工具
  tools/send-guard.ts 拒绝连续调用发送工具
  tools/qq.ts        QQ 工具注册
docs/
  commit-audit-7a3a106.md  提交审计报告（7a3a106 起）
  commit-audit-c90b2bc.md  提交审计报告（c90b2bc 起）
  commit-audit-cb7bb0b.md  提交审计报告（cb7bb0b 起）
  configuration.md   配置取值规则与限制
  design-review.md   设计审查与修复记录
  emoji.md           收藏表情（表情包）说明
tests/               vitest 用例
```

## License

[CC BY-NC-SA 4.0](./LICENSE)

第三方依赖的版权声明与许可文本见 [NOTICE](./NOTICE)。
