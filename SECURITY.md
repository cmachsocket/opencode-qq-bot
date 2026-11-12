# 安全策略

opencode-qq-bot 是一个 OpenCode V2 插件：它从 NapCat（OneBot 11）接收 QQ 群聊与私聊消息，
交给 OpenCode 会话里的模型处理，再通过 `qq_*` 工具把回复发回聊天。它在本机持有
`napcat.token`、环境变量里的模型密钥，能读写工作目录与媒体目录，并把聊天内容交给模型供应商。
**请按「群友的一句话可能影响这台机器」的标准对待任何权限缺口。**

---

## 报告漏洞

**不要在公开 issue 里贴漏洞细节、可用 PoC、token、真实 QQ 号/群号或本机路径。**

请用 GitHub 的私密漏洞上报：

> <https://github.com/cmachsocket/opencode-qq-bot/security/advisories/new>

写清楚：影响版本、复现步骤、影响面（能读到什么 / 能做什么）、你建议的修法（如果有）。
不要求先写好补丁。不确定算不算漏洞也走这个渠道问，比开公开 issue 好。

## 响应方式（据实说明）

单人维护，**没有 SLA、没有 72 小时承诺**。唯一承诺：报告有效时，修完会在 release notes 里写明，
并在 advisory 里登记贡献者（除非要求匿名）。

- 受支持版本：npm 上**最新一个 release 线**。更早的版本只确认「是否受影响」，不单独发补丁。
- 已公开讨论、上游已有 CVE 的依赖问题：交给 CI 里的 `bun audit`，不必单独上报。

---

## 明确在范围内（In scope）

| 类别                         | 例子                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------ |
| **凭据泄漏**                 | token / 模型密钥出现在日志、错误信息、模型上下文、QQ 出站消息里（CWE-532）     |
| **提示注入导致的真实副作用** | 群友一条消息就能让模型改配置、绕过白名单、发消息给别的会话或读本机文件         |
| **SSRF / 内网探测**          | 入站图片下载或出站远端媒体能访问私网、回环、云元数据地址，或跟随重定向绕过判定 |
| **越权访问会话**             | 一个群 / 私聊读到另一个会话的消息、历史或状态；群聊拿到私聊内容                |
| **路径穿越 / 任意文件读取**  | `qq_send_image` / `qq_send_record` 能发出白名单目录之外的文件（含软链接逃逸）  |
| **本地执行能力外溢**         | QQ 会话里的模型获得了插件声明之外的文件写入或子进程能力                        |
| **单实例与状态**             | 两个插件实例同时消费同一个 NapCat 连接、抢同一个工作目录或日志文件             |
| **依赖供应链**               | 依赖被投毒，或 `postinstall` 补丁被利用                                        |

## 明确不在范围内（Out of scope）

- NapCat、QQ 平台、OpenCode 或模型供应商自身的问题（请报给对应项目）。
- 因为没有配置白名单而「所有群都能用」——这是部署选择，不是漏洞；但**默认配置不安全**的反馈仍然欢迎。
- 需要本机管理员权限、已能读写进程内存或已能改 `.env` / `opencode.json` 的场景。
- 模型输出质量、回复内容是否得体、限流阈值是否符合你的预期。

---

## 部署侧硬要求

这些不是建议，是「按设计能成立」的前提：

1. `opencode.json(c)`、`config.json`、NapCat 的 token **不进仓库、不进同步盘**。仓库只提交 `opencode.example.json`；`config.json` 与 `opencode.json` 都由你自己维护。
2. 配好 `groups` / `users` 白名单；空数组表示「不响应」，不要为了图省事放开全部。
3. 日志（`$XDG_STATE_HOME/opencode-qq-bot/logs`）、媒体（同目录下 `media`）与机器人工作目录不要放在公开目录或网盘同步目录。
4. `media.allowedDirs` 只放开真正需要的目录，不要直接给家目录或 `/`。
5. 插件进程用普通用户跑，不要用 root；NapCat 与插件按最小权限分开部署。
6. 工作目录里的文件等于「模型能看到的上下文」：不要把密钥、私钥、生产配置放进去。

---

## English summary

This is a single-maintainer OpenCode plugin that bridges QQ chats to a model session.
Please report vulnerabilities **privately** via
<https://github.com/cmachsocket/opencode-qq-bot/security/advisories/new> — never in a public
issue, and never include secrets, real QQ numbers, or PoCs in public text.

There is no SLA. Supported versions are the latest npm release line. In scope: credential
leakage into logs / model context / outbound messages, prompt-injection side effects, SSRF
(inbound image download and outbound remote media), cross-session data access, path traversal
and symlink escapes in outbound media, instance/bot-lock bypass, and dependency supply-chain
issues. Out of scope: issues in NapCat, QQ, OpenCode or model providers; misconfiguration;
scenarios that already require local administrator access.

Hard deployment requirements: keep `opencode.json` / `.env` / tokens out of the repository and
sync folders, configure group/user allowlists, keep logs and media in private state
directories, restrict `media.allowedDirs`, and run as an unprivileged user.
