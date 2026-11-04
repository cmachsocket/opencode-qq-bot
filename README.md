# opencode-qq-bot

把 QQ 群聊接进 OpenCode V2 的插件。通过 [NapLink](https://www.npmjs.com/package/@naplink/naplink) 连 NapCat（OneBot 11），
每个群对应一个 OpenCode 会话，模型用 `qq_*` 工具把回复发回群里。

- 群消息 → OpenCode 会话 → 模型回复 → 群里
- 会话忙碌时新消息先缓存，空闲后合并成一轮再投进去
- 语音自动转写、图片内联进会话、引用与合并转发展开成文本块
- 角色设定放在 `SOUL.txt`

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
  "plugins": [
    {
      "package": "./",
      "options": {
        // 不配置或留空数组时，所有群都不响应
        "groups": [123456789],
      },
    },
  ],
}
```

`package` 可以是本地路径，也可以是发布到 npm 的包名。


## 配置

插件选项优先于环境变量，环境变量优先于默认值。

**凭证不写进仓库**：NapCat 地址与令牌只能来自环境变量或插件选项，仓库里只保留占位符。
复制 `.env.example` 为 `.env` 并填入真实值，`.env` 已被 `.gitignore` 忽略。

```sh
cp .env.example .env
```

| 选项                                | 环境变量                        | 默认值          | 说明                                            |
| ----------------------------------- | ------------------------------- | --------------- | ----------------------------------------------- |
| `napcat.url`                        | `NAPCAT_WS_URL`                 | 无（必填）      | NapCat 正向 WebSocket 地址                      |
| `napcat.token`                      | `NAPCAT_WS_TOKEN`               | 无              | NapCat 访问令牌                                 |
| `groups`                            | `QQ_TARGET_GROUPS`              | `[]`            | 参与对话的群号，逗号分隔                        |
| `soulPath`                          | `QQ_BOT_SOUL_PATH`              | 包内 `SOUL.txt` | 角色设定文件路径                                |
| `agent`                             | `QQ_BOT_AGENT`                  | OpenCode 默认   | 会话使用的 agent                                |
| `model`                             | `QQ_BOT_MODEL`                  | OpenCode 默认   | 会话使用的模型，格式 `provider/model[/variant]` |
| `sendDelayMs`                       | `QQ_SEND_DELAY_MS`              | `1000`          | 拆行发送时每条之间的间隔                        |
| `warnLength`                        | `QQ_WARN_LENGTH`                | `20`            | 单条消息超过该长度时告警                        |
| `reuseSession`                      | `QQ_REUSE_SESSION`              | `false`         | 重启后复用上一次的会话                          |
| `busyTimeoutMs`                     | `QQ_BUSY_TIMEOUT_MS`            | `300000`        | 会话超过该时长未结束视为卡死，强制放行缓存消息  |
| `proactive.enabled`                 | `QQ_PROACTIVE_ENABLED`          | `true`          | 是否启用主动说话                                |
| `proactive.silenceThresholdSeconds` | `QQ_PROACTIVE_SILENCE_SECONDS`  | `10800`         | 沉默多久后才开始计算主动说话概率                |
| `proactive.startProbability`        | `QQ_PROACTIVE_P_START`          | `0.01`          | 刚跨过阈值时的概率                              |
| `proactive.probabilityPerHour`      | `QQ_PROACTIVE_P_SLOPE_PER_HOUR` | `0.05`          | 每多沉默一小时概率的增量                        |
| `proactive.tickSeconds`             | `QQ_PROACTIVE_TICK_SECONDS`     | `3600`          | 心跳间隔，必须大于 0                            |
| `reminder.enabled`                  | `QQ_REMINDER_ENABLED`           | `true`          | 模型一轮没调用发送工具时是否提醒                |
| `reminder.max`                      | `QQ_REMINDER_MAX`               | `2`             | 连续提醒次数上限                                |

没配置 `groups` 时插件不会响应任何消息（默认全部关闭）。

布尔环境变量接受 `true/false`、`1/0`、`yes/no`、`on/off`；数值直接写数字。
写错的配置项会输出告警并回退到默认值，不会静默失效。
取值规则与图片内联限制见 [docs/configuration.md](docs/configuration.md)。

## 工具

模型只能操作当前会话绑定的群，工具都带 `qq_` 前缀：

| 工具                       | 说明                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `qq_send_message`          | 发消息。`content` 文本，`reply=false` 表示已读不回，`unlimit_length=true` 解除长度告警 |
| `qq_send_image`            | 发图片，`file` 传路径或 URL，`base64` 传 `base64://` 数据                              |
| `qq_send_record`           | 发语音                                                                                 |
| `qq_send_forward`          | 发合并转发，`nodes` 为节点列表                                                         |
| `qq_send_poke`             | 戳一戳                                                                                 |
| `qq_delete_message`        | 撤回消息                                                                               |
| `qq_get_group_member_info` | 查群名片与昵称                                                                         |
| `qq_fetch_ptt_text`        | 语音转文字                                                                             |
| `qq_get_login_info`        | 机器人自己的 QQ 号与昵称                                                               |

## 行为

- **回复是强制的**：系统提示要求模型每轮调用一次 `qq_send_message`，直接输出的文字会被丢弃。
- **被 @ 才必须回**：没被 @ 时模型可以调用 `reply=false` 选择已读不回。
- **消息合并**：会话正在跑模型时新到的消息进缓存，会话空闲后合并成一轮再投进去。
- **提醒**：模型一轮完全没调用发送工具时，插件会补一条合成消息提醒它，最多 `reminder.max` 次，
  每个新的用户轮次都会重新给一份预算。
- **主动说话**：群沉默超过阈值后，按概率发起话题。
- **图片**：远端图片会下载后内联进提示，单张不超过 5MB、单轮最多 8 张、总量不超过 16MB，
  超出的图片只保留 `[图片]` 占位文本。

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
src/
  config.ts          配置合并与校验
  index.ts           插件入口
  logger.ts          日志
  naplink/client.ts  NapLink 连接与 API 门面
  naplink/render.ts  消息段 → 文本与图片附件
  session/prompt.ts  角色设定与系统提示
  session/manager.ts 群 ↔ 会话映射、消息缓存
  tools/qq.ts        QQ 工具注册
docs/
  configuration.md   配置取值规则与限制
tests/               vitest 用例
```

## License

[GPL-3.0-or-later](./LICENSE)
