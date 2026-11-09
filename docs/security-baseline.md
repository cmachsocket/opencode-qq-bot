# 安全基线

这份文档把「这个插件靠什么成立」写成可核对的清单：信任边界在哪、数据流向哪、
哪些不变量不能被改坏、每条不变量由哪个文件保证、由哪个测试盯着。

改代码前先看这里；新增能力时按[变更流程](#变更流程)逐条勾选。

## 信任边界

群友完全控制消息内容，模型输出不完全可信，插件进程本身是可信的。边界只有一条：
**插件进程之内可信，进程之外（QQ 群友、NapCat、模型供应商、远端图床）一律按不可信处理。**

```text
QQ 群友 / 私聊对象                    ← 完全不可信
      ↓ 消息（文本、引用、转发、语音、图片 URL、群名片、文件名）
NapCat（OneBot 11，本机或远端）        ← 不可信边界
      ↓ WebSocket（napcat.token 鉴权）
插件进程（本机，普通用户）             ← 可信
      ├─ 入站：结构净化 → 历史拼装 → OpenCode 会话
      ├─ 本地状态：工作目录 / 日志 / 媒体 / 锁
      └─ 出站：凭证拦截 → 文本转换与切分 → 限流 → NapCat API → QQ
      ↓ HTTPS
模型供应商 API                        ← 不可信（会看到聊天内容）
      ↑ 模型输出（可能被群友提示注入影响）
```

## 数据离机清单

| 数据                                 | 去哪                         | 触发点                             | 备注                                           |
| ------------------------------------ | ---------------------------- | ---------------------------------- | ---------------------------------------------- |
| 聊天文本、群名片、文件名、引用与转发 | 模型供应商 API               | 每一轮会话                         | 进模型前已做结构净化与绝对时间标注             |
| 图片内容                             | 模型供应商 API               | 图片进入会话时                     | 插件先把图片下载到媒体目录，再作为附件交给会话 |
| 工具结果与模型输出                   | 模型供应商 API               | 模型调用工具 / 生成回复            | 输出侧还要过凭证拦截                           |
| 远端媒体 URL                         | NapCat → 目标站点            | `qq_send_image` / `qq_send_record` | 插件只预检地址，下载由 NapCat 完成             |
| 入站图片 URL                         | 目标站点（第三方图床 / CDN） | 收到图片消息                       | 由插件下载，只允许公网地址                     |

不会离机的：`napcat.token`、模型密钥、日志文件、工作目录里的其它文件（除非模型显式
通过发送工具发出去，而发送工具只认白名单目录）。

## 本机落盘

| 内容                   | 默认位置                                   | 说明                                                        |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| 工作目录（会话上下文） | `$XDG_DATA_HOME/opencode-qq-bot/workspace` | 未设置时 `~/.local/share/...`；`botLockFile` 等状态也在附近 |
| 日志                   | `$XDG_STATE_HOME/opencode-qq-bot/logs`     | 未设置时 `~/.local/state/...`；每行脱敏后写入               |
| 媒体缓存               | `$XDG_STATE_HOME/opencode-qq-bot/media`    | 入站图片与表情打标产物                                      |
| 机器级锁               | 工作目录旁的锁文件                         | 同一台机器只允许一个实例消费 NapCat                         |

这些目录都不要放进仓库、网盘同步目录或公开可读路径。

## 不变量

| #   | 不变量                                                                                                                                                                             | 实现                                                               | 测试                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 1   | 凭证不落日志：message、meta、Error stack 都逐行脱敏                                                                                                                                | `src/logger.ts`、`src/sensitive.ts`（`maskSecrets`）               | `tests/logger.test.ts`、`tests/sensitive.test.ts`                              |
| 2   | 凭证不出 QQ：命中即整条不发，且不把凭证写进错误说明                                                                                                                                | `src/sensitive.ts`、`src/tools/qq.ts`                              | `tests/sensitive.test.ts`、`tests/tools.test.ts`                               |
| 3   | 群友文本伪造不出系统结构：换行、零宽字符、结构标签先净化                                                                                                                           | `src/model-view.ts`                                                | `tests/model-view.test.ts`                                                     |
| 4   | 入站图片只从公网拉：连接级 IP 判定 + 端口白名单 + 不跟随跳转                                                                                                                       | `src/safe-fetch.ts`                                                | `tests/safe-fetch.test.ts`                                                     |
| 5   | 出站媒体只发白名单目录（含软链接与目录边界判定）；远端地址只允许公网                                                                                                               | `src/media-path.ts`、`src/tools/qq.ts`                             | `tests/media-path.test.ts`、`tests/tools.test.ts`                              |
| 6   | 出站限流按目标隔离，超限拒绝并说明                                                                                                                                                 | `src/rate-limit.ts`                                                | `tests/rate-limit.test.ts`                                                     |
| 7   | 不允许一轮里连续调用发送工具                                                                                                                                                       | `src/tools/send-guard.ts`                                          | `tests/send-guard.test.ts`                                                     |
| 8   | 内置 `question` 工具被拦下（TUI 弹窗会阻塞）                                                                                                                                       | `src/tools/ask-guard.ts`                                           | `tests/ask-guard.test.ts`                                                      |
| 9   | 每个群聊 / 私聊固定映射到自己的会话，互不串消息                                                                                                                                    | `src/session/manager.ts`                                           | `tests/manager.test.ts`                                                        |
| 10  | 同一台机器只跑一个实例：进程内接管 + 机器级锁                                                                                                                                      | `src/instance.ts`、`src/bot-lock.ts`                               | `tests/instance.test.ts`、`tests/bot-lock.test.ts`                             |
| 11  | 会话工作目录固定，不随加载插件的项目漂移                                                                                                                                           | `src/home.ts`                                                      | `tests/home.test.ts`                                                           |
| 12  | 白名单为空即不响应，配置错误按拒绝处理                                                                                                                                             | `src/config.ts`                                                    | `tests/config.test.ts`                                                         |
| 13  | 回合失败只补固定文案：上游异常原文不进聊天，同目标 5 分钟节流                                                                                                                      | `src/session/manager.ts`                                           | `tests/manager.test.ts`                                                        |
| 14  | 工具按角色与聊天收窄：普通成员与主动说话按 `chat` / `proactive` 档（联网、网页抓取、`qq_*`），只有 owner / 管理员才用 `admin` 档（`allow: ["*"]`，即全部本地工具）；执行前二次拦截 | `src/tools/policy.ts`、`src/tools/policy-guard.ts`、`src/index.ts` | `tests/policy.test.ts`、`tests/policy-guard.test.ts`、`tests/commands.test.ts` |
| 15  | QQ 会话里不创建子代理：子会话无法继承按聊天的工具限制，配置档放行也拒绝                                                                                                            | `src/tools/policy-guard.ts`                                        | `tests/policy-guard.test.ts`                                                   |
| 16  | 无人值守轮次（主动说话）不得使用 `admin` 档：上下文完全来自聊天内容，按最低权限角色执行                                                                                            | `src/session/manager.ts`、`src/tools/policy.ts`                    | `tests/manager.test.ts`、`tests/policy.test.ts`                                |

已知局限（不是 bug，但改代码时要记住）：

- 出站远端媒体是「预检一次 + NapCat 下载时再解析一次」，存在 DNS 重绑定窗口。
- 本地媒体路径要求 NapCat 与插件能访问同一份文件系统。
- 远端媒体没有插件侧的大小上限，由 NapCat 侧决定。
- 日志轮转的清理依赖文件已落盘，启动瞬间的连续写入可能多留几个文件。

## 变更流程

新增或修改下面这些内容时，逐条确认，并在 PR / 提交说明里写明新增的测试：

1. **新增外部请求**：必须走 `src/safe-fetch.ts`（连接级判定）或 `src/media-path.ts`（出站预检），
   不允许直接 `fetch` 一个由群友控制的地址。
2. **新增文件读写**：写死在机器人工作目录或状态目录下；读用户文件必须经过媒体白名单。
3. **新增出站内容**：确认经过 `src/sensitive.ts`，并且失败时的错误说明里不带原文。
4. **新增工具**：确认它在 QQ 会话里只做插件允许的事，没有隐式的本地执行能力。
5. **新增配置项**：同步 `docs/configuration.md`、`.env.example`、README 表格与 `tests/docs.test.ts`。
6. **新增依赖**：同步 `NOTICE` 的依赖表，`tests/notice.test.ts` 会检查覆盖情况。
7. **新增真实标识或凭证**：不要写进仓库。CI 会用 `scripts/trufflehog.yml` 扫本次 push / PR
   的提交，命中真实群号、凭证赋值或 PEM 私钥即失败；本地 `bun run privacy:scan` 会扫全部历史。
8. **改动以上任一不变量**：先更新本文档的表格，再改代码与测试。

发布前的自动门禁见 [release.md](./release.md)；漏洞上报方式见 [SECURITY.md](../SECURITY.md)。
