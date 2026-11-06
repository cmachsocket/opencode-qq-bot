# 配置参考

插件选项优先于环境变量，环境变量优先于默认值。完整列表见 [README](../README.md#配置)，
这里补充取值规则与边界行为。

## 取值规则

- **布尔**：`true` / `false`、`1` / `0`、`yes` / `no`、`on` / `off`，不区分大小写。
  写错（例如 `maybe`）会回退到默认值并输出告警。
- **数值**：直接写数字，例如 `250`、`0.01`。写错会回退到默认值并输出告警。
- **群号 / QQ 号**：逗号分隔，例如 `123,456`；插件选项里写成数组。重复项会去重，
  非正整数会被忽略并告警。
- **模型**：`provider/model` 或 `provider/model/variant`。
  写错会回退到默认模型并输出告警。
- **未知配置项**：顶层和 `napcat`、`proactive`、`reminder`、`keepAlive` 下的未知键会输出告警，
  不会被静默忽略。

## 数值范围

| 配置项                              | 约束       |
| ----------------------------------- | ---------- |
| `sendDelayMs`                       | 大于等于 0 |
| `warnLength`                        | 大于等于 1 |
| `reminder.max`                      | 大于等于 0 |
| `proactive.silenceThresholdSeconds` | 大于等于 0 |
| `proactive.startProbability`        | 0 到 1     |
| `proactive.probabilityPerHour`      | 0 到 1     |
| `proactive.tickSeconds`             | 大于 0     |
| `keepAlive.seconds`                 | 大于 0     |

越界值会回退到默认值并告警。

## 配置告警

写错的配置项不会静默失效，插件启动时会逐条输出告警：

```
[qq-bot] warn QQ_SEND_DELAY_MS 不是合法的数字：abc
[qq-bot] warn QQ_BOT_MODEL 格式无效：openai（应为 provider/model[/variant]）
```

`proactive.tickSeconds` 必须是正数，否则心跳会退化成毫秒级热循环，非正数会回退到默认值。
`startProbability` 与 `probabilityPerHour` 表示目标每小时概率，实际每个心跳的触发概率会按
`tickSeconds` 换算，修改心跳间隔不会改变整体触发频率。

## 保活

OpenCode 默认在 location 空闲 60 分钟后卸载它的服务，插件随之被卸载，
NapCat 连接断开后机器人就不再响应。

| 手段                                      | 作用                                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| `experimental.location_idle_timeout`      | OpenCode 自身的配置，设为 `false` 就不再自动卸载（推荐）     |
| `keepAlive.enabled` / `keepAlive.seconds` | 插件的保活心跳，周期性写回会话元数据来刷新 location 空闲计时 |

`keepAlive.seconds` 必须小于 OpenCode 的 location 空闲超时（默认 3600 秒），
心跳间隔过大就来不及刷新。插件的心跳跑在一个不绑定 QQ 目标的专用会话上，
不影响群聊会话，也不消耗模型调用。

## 角色设定

`souls/` 目录里可以放多份角色设定，`soulName` 选生效的那份，`soulPath` 可以覆盖成任意文件或目录。

| 情况            | 生效文件                                          |
| --------------- | ------------------------------------------------- |
| 只配 `soulName` | `souls/<soulName>`（从插件目录向上找 `souls/`）   |
| 只配 `soulPath` | 该路径指向的文件；指向目录时取目录下的 `soulName` |
| 两个都配        | `soulPath` 优先                                   |
| 都没配          | `souls/default.txt`                               |

- `soulName` 默认 `default.txt`。
- 文件内容改动会被监听，下一轮立即用新设定；文件稍后创建也会被捡到。
- 换角色改 `soulName`：写进 `opencode.json(c)` 保存后 OpenCode 重载插件后生效。

## 图片文件

OpenCode 的附件只接受 `file:` 与 `data:`。远端图片会先下载到受控临时目录，
再以 `file:` 引用交给会话，避免 base64 字符串进入插件缓存和每轮 prompt。

| 限制             | 值   | 说明                                   |
| ---------------- | ---- | -------------------------------------- |
| 单张图片字节上限 | 5MB  | 超过则只保留 `[图片]` 占位文本         |
| 单轮图片数量上限 | 8 张 | 超出部分只保留占位文本                 |
| 单轮图片字节总量 | 16MB | 按原始字节计算，超出部分只保留占位文本 |
| 临时文件保留时间 | 7 天 | 过期文件由插件定期清理                 |

单轮提示指一条消息渲染出来的附件，以及会话空闲时合并多轮消息后的附件。
超出限制的图片不会下载，只有占位文本会进入提示词。
下载使用 15 秒超时、拒绝重定向、拒绝本机与内网地址，并按魔数校验图片类型。
