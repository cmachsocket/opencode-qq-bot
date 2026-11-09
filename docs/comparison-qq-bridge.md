# 与 qq-bridge 的能力对比（候选清单）

> 状态：**已评审**，全部候选条目**采纳**，作为后续排期的依据。
> 评审过程：逐条讨论的部分见各条目的「结论」列；其余条目由维护者一次性批量采纳（未逐条展开）。
> 已确认的缺陷单独列在「已确认缺陷」一节；不做的、框架侧的、不属于本项目职责的都不写在这里。
> 尚未实现的条目 = 早期阶段的待办，不等于缺陷，优先级见「八、评审记录」。
> 各条目**当前是否已实现**、落在哪个文件、配置面是什么，见 [`comparison-status.md`](./comparison-status.md)。

## 项目定位与职责边界

本项目做的是 **QQ 聊天的生命周期管理**：接消息 → 渲染 → 分发到会话 → 收模型回复 → 发回 QQ，
外加会话绑定、忙碌判定、失败恢复、提醒、主动说话、收藏表情这些"让机器人一直在群里活着"的机制。

不由本项目负责：

| 领域                           | 归谁                                                |
| ------------------------------ | --------------------------------------------------- |
| 模型看到什么上下文、上下文质量 | OpenCode（可用 opencode-mem / opencode-dcp 等扩展） |
| 模型记住什么                   | 同上                                                |
| OneBot 其余动作面              | SnowLuma MCP（可选，read 模式）                     |
| 通用模型能力                   | OpenCode（bash / read / webfetch / 子代理等）       |
| token 用量与成本核算           | OpenCode                                            |

判定准则：改进项若落在"模型看到什么 / 记住什么 / 怎么想"上，先问它是不是框架职责。
qq-bridge 把这些也自己做了一遍（39 个 MCP 工具 + token 台账），那是它的产品定位带来的，不是本项目要追平的清单。

## 对比对象与前提

|        | 本项目 `opencode-qq-bot` | 对照项目 `qq-bridge`                                 |
| ------ | ------------------------ | ---------------------------------------------------- |
| 形态   | OpenCode V2 插件（TS）   | 独立 Node 进程（JS），桥接 OneBot ↔ DeepSeek Harness |
| 规模   | `src/` 约 5.6k 行        | `src/bridge.js` 单文件 13.7k 行，合计约 49k 行       |
| 部署面 | 一个插件                 | 两个常驻服务 + 手工 patch 第三方 SDK                 |

---

## 一、类型定义

| 标签         | 含义                                         |
| ------------ | -------------------------------------------- |
| **边界**     | 缺少可执行的硬约束，可能造成安全或账号风险   |
| **缺口**     | 功能尚未覆盖                                 |
| **基建**     | 工程设施缺失，影响长期维护                   |
| **尚未实现** | 早期阶段的正常待办，不视为缺陷，优先级可自定 |

---

## 二、候选条目

### A. 边界类（潜在风险）

| #   | 条目                                                                | 本项目现状                                                                                                                                                                                          | qq-bridge 对照                                                                                                                            | 结论 / 备注                                                                                    |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A1  | 出站发送无速率限制                                                  | `src/tools/qq.ts` 无频次计数，仅 `sendDelayMs=1000` 拆段间隔；主动说话也无频率上限                                                                                                                  | `maxSendPerMinute=8` / `maxSendPerHour=60` / `burstMaxMessages=8` / `maxMessageChars=500` / `gapBaseMs+gapPerCharMs`                      | **采纳**（已实现，见「A1 的落地方式」）                                                        |
| A2  | 出站无敏感信息拦截                                                  | `src/sensitive.ts`：NFKC + 零宽归一化、base64 变体、已知凭证与 12 字符分片检测、凭证路径检测，发送前整条拦截                                                                                        | `src/sensitive.js`（NFKC+零宽归一化、base64 变体、路径/凭证赋值正则）+ `KNOWN_AGENT_TOKENS` + 12 字符分片检测 + `auditAndSend()` 整条拦截 | **采纳**（已实现，见「A2 的落地方式」）；OpenCode 的 agent token 常驻环境，注入后可外发        |
| A3  | 群消息原文直入 prompt                                               | `src/model-view.ts` 净化后拼成 `[绝对时间] 名字(角色)?: 正文`                                                                                                                                       | `src/qq-model-view.js`：`sanitizeUntrustedText`（全角 `【】`、换行、零宽）+ `compactModelMessage`（先净化再去重 + 相对时间）              | **采纳**（已实现，见「A3 的落地方式」）                                                        |
| A4  | QQ 会话的工具面处置未定                                             | 已有 `src/tools/ask-guard.ts` 拦内置 question——**因为它会在 TUI 弹出选择框，没有 QQ 用户能应答，整轮会卡住**；这是避免阻塞，不是安全闸门。其余工具（bash/write/edit/webfetch/subagent）当前一律放开 | 注册期 `tools.restrict` + 执行期白名单（仅 MCP 白名单前缀 + `ask_user_question`/`todo_write`）                                            | **采纳（已实现，见「A4 / B3 / B4 的落地方式」）**：question 继续保留；其余工具按角色与聊天收敛 |
| A5  | SSRF 判定只做字符串匹配                                             | 已加固：`src/safe-fetch.ts` 把判定挪到连接层（DNS 解析后逐个 IP 校验 + 端口白名单 + 不跟随跳转），原来的 `isPrivateHost` 字符串判定已删除                                                           | `src/safe-fetch.js`：DNS 全量校验 → 连已校验 IP + 保留 Host/SNI → 逐跳重校验 → 端口白名单 `[80,443,8080,8443]`                            | **采纳**（已实现，见「A5 的落地方式」）                                                        |
| A6  | `qq_send_image` / `qq_send_record` 的 `file` 接受任意本地路径或 URL | 直接透传给 NapCat，无目录白名单                                                                                                                                                                     | 语音侧有库白名单 + `safeJoinLibrary` 路径穿越防护                                                                                         | **采纳（已实现，见「A6 的落地方式」）**                                                        |

### A1 的落地方式（已实现）

模型在一轮里可以连着发任意多条消息，出站没有频次计数：群里会刷屏，也容易碰到平台风控。
插件新增 `src/rate-limit.ts`，出站消息按目标（群 / 私聊）单独计数，超限时直接拒绝这次发送。

| 手段             | 配置项                                               | 默认值 | 行为                             |
| ---------------- | ---------------------------------------------------- | ------ | -------------------------------- |
| 每分钟硬上限     | `rateLimit.maxPerMinute`（`QQ_RATE_MAX_PER_MINUTE`） | `8`    | 超出则拒绝发送，并把原因回给模型 |
| 每小时硬上限     | `rateLimit.maxPerHour`（`QQ_RATE_MAX_PER_HOUR`）     | `60`   | 同上                             |
| 相邻发送最小间隔 | `rateLimit.minGapMs`（`QQ_RATE_MIN_GAP_MS`）         | `1500` | 间隔不足则先等一等再发，不丢消息 |

- 计数按目标分开：群 A 刷屏不影响群 B。
- 超长消息拆出的每一段都算一条；同一段消息内部的多段共用一个操作 id，段与段之间只按 `sendDelayMs` 等待，不叠加限流间隔。
- 被限流拒绝时本轮同样算已回复，不会再触发「补发提醒」，回给模型的说明里写明请停止发送并结束本轮。
- 主动说话走的是同一条路径（模型 → `qq_send_message`），因此同样受限流约束。
- 插件自己生成的消息（`/emoji-label` 的结果与进度）走另一个计数域：只受间隔约束，不占用模型回复的额度。
- 三个值都为 `0` 表示不限制；计数只存在内存里，插件重启后重新开始。

与上游 qq-bridge 的差别：上游用 `maxSendPerMinute` / `maxSendPerHour` / `burstMaxMessages` / `gapBaseMs+gapPerCharMs`，
本项目用「每分钟 / 每小时硬上限 + 固定最小间隔」达到同样目的，不做按字符长度的动态间隔。

### A2 的落地方式（已实现）

出站消息在发送前统一过一遍敏感信息检查（`src/sensitive.ts`），命中就整条不发。

检测本身用现成的 [`flare-redact`](https://github.com/flare-collection/flare-redact)（MIT、零运行时依赖、同步 `scan()`），
选它而不是 `openredaction`：本项目的目标是拦**凭证**，不是做 PII 合规；`flare-redact` 的检测器可以按 id 精确取舍，
`openredaction` 的 PII 检测器会把群聊里正常出现的邮箱、手机号、QQ 号当成敏感信息。

| 手段         | 做法                                                                                                         | 补上了什么                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| 凭证格式检测 | 用 flare-redact 的默认检测器，去掉 `email` / `obfuscated_email` / `credit_card` / `iban`，补上 `seed_phrase` | 各家 API key、JWT、Bearer、私钥、凭证赋值          |
| 已知凭证     | 环境变量名像密钥的值 + `napcat.token`，编译成正则检测器                                                      | 上游的 `KNOWN_AGENT_TOKENS`                        |
| 分片检测     | 去掉分隔符后按 12 字符滑动比对                                                                               | 凭证被空格、换行拆开也能认出来                     |
| 归一化       | NFKC 全角转半角 + 去掉零宽字符                                                                               | `ｐａｓｓｗｏｒｄ＝…`、`pass\u200bword=…` 这类绕过 |
| base64 变体  | 解码文本里 ≥20 字符的 base64 / base64url 片段，解出可读文本后再扫一遍                                        | 编码后的凭证                                       |
| 凭证路径     | 命中 `.ssh` / `.aws` / `.gnupg` / `.kube` / `.env` / `id_rsa` 等路径片段                                     | 把凭证文件路径发出去                               |

- 覆盖 `send_message`（剥离 markdown 后的正文）、`send_image` / `send_record`（非 `base64://` 的 `file`）、`send_sticker`（表情地址）、`send_forward`（节点正文）。
- 命中时工具抛出错误，发送守卫会解除「已发送」标记，本轮也不记为已回复：模型可以删掉凭证后立刻重发。
- 检查在拆段之前做，超长消息只要有一段命中，整条都不发。
- 只拦凭证，不拦邮箱、手机号、QQ 号、银行卡号；普通聊天与 UUID / URL 不会误伤。
- 新增配置项 `sensitive.enabled`（`QQ_SENSITIVE_ENABLED`），默认开启。

### A3 的落地方式（已实现）

群友发的文本完全可控，直接拼进提示词就能伪造系统段落或跨行结构。插件在消息进会话前统一做结构净化（`src/model-view.ts`）：

| 措施             | 做法                                                      | 挡住什么                             |
| ---------------- | --------------------------------------------------------- | ------------------------------------ |
| 换行折平         | `\r\n`、U+2028/U+2029、U+0085、U+000B/U+000C 全换成空格   | 正文跨不了行，伪造不出新段落         |
| 零宽字符清零     | 去掉 U+200B..U+200F、U+2060、U+FEFF                       | 伪造不出「看着正常但匹配不上」的标记 |
| 全角方括号换半角 | `【】` 换成 `[]`                                          | 伪造不出 `【系统】` 段落             |
| 结构标签换全角   | `<quote>` / `<forward>` / `<history>` 换成 `＜quote＞` 等 | 伪造不出本插件的结构块               |
| 整条消息整体净化 | 消息拼好之后对整段文本再净化一次                          | 标签拆成两段发过来也伪造不出来       |
| 名字去控制字符   | 群名片、昵称去掉控制字符与零宽字符                        | 群名片伪造不出系统角色               |
| 按消息 ID 去重   | 同一批里重复投递的同一条消息只留一份                      | 同一句话把模型刷两遍                 |

净化覆盖正文、引用块、合并转发节点、语音转写、文件名和群名片。

逐段净化只挡得住单段里的标签：`<` 与 `quote>` 分处两段时匹配不到，拼起来仍是一个标签。
所以整条消息渲染完成后还会整体净化一次；插件自己展开的引用块与转发块用私用区占位符保护，
净化之后才还原成真正的结构标签。

时间标注用**绝对时间**（维护者决定）：每条消息行是 `[YY-MM-DD HH:MM] 名字(owner|admin)?: 正文`，方括号里是本地时区的绝对时间，名字后面只给 owner / 管理员标角色，普通成员没有标记，也不再显示 QQ 号。与上游 qq-bridge 的差别是**不给相对时间**（上游给 `at` + `ago`），这里只给绝对时间，模型自己就能判断这条消息有多旧。

落地位置：`src/model-view.ts`（净化与时间标注）、`src/naplink/render.ts`（各消息段净化与整条消息的整体净化）、`src/naplink/history.ts`（历史消息同样标注）、`src/index.ts`（消息行拼装）、`src/session/prompt.ts`（系统提示说明新格式）。

### A5 的落地方式（已实现）

入站图片的下载地址由群友控制。只看域名长什么样挡不住 DNS 重绑定：域名解析出来的地址随时可以变。
插件新增 `src/safe-fetch.ts`，把判定从「域名长什么样」挪到「连接的那一刻」。

| 手段             | 做法                                                                                                                              | 挡住什么                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 连接前解析 DNS   | 用 [`request-filtering-agent`](https://github.com/azu/request-filtering-agent) 的 http(s).Agent，解析出的每一个地址都要过公网判定 | 回环、私网、CGNAT `100.64/10`、`198.18/15`、IPv4-mapped、NAT64、6to4、链路本地、组播、元地址 |
| 连刚判定过的地址 | 判定与建连是同一步，没有「判完再查一次」的空窗                                                                                    | DNS 重绑定                                                                                   |
| Host / SNI 不变  | 只换连接目标，域名照旧                                                                                                            | 证书校验与虚拟主机不受影响                                                                   |
| 端口白名单       | 只放行 `80` / `443` / `8080` / `8443`                                                                                             | 打到公网主机上的冷门端口                                                                     |
| 不跟随跳转       | 3xx 直接算失败                                                                                                                    | 用跳转绕过判定                                                                               |

- 只影响入站图片下载路径（`src/naplink/media.ts`）。
- 原来的 `isPrivateHost` 字符串判定删除：它既漏网段，也挡不住重绑定。
- 原本的 `fetch` 换成 `node:http` / `node:https` + 过滤 agent——Node 与 Bun 的 `fetch` 都不接受 `http.Agent`。
- 下载实现可替换（`MediaStore` 的 `fetcher`），测试用假实现，不依赖网络。

与上游 qq-bridge 的差别：上游是自己写的 `safe-fetch.js`，思路相同；上游跟随跳转并逐跳重校验，
本项目直接不跟随跳转（3xx 算失败），少一层攻击面；判定本身用现成的 request-filtering-agent，不重复造轮子。

### A6 的落地方式（已实现）

`qq_send_image` / `qq_send_record` 的 `file` 以前直接透传给 NapCat：插件进程能读到的文件，
模型都能发进群。新增出站媒体把关（`src/media-path.ts`），本地路径只允许白名单目录，
远端地址由插件自己下载（只允许公网地址）。

| 手段       | 做法                                                                            | 挡住了什么                                     |
| ---------- | ------------------------------------------------------------------------------- | ---------------------------------------------- |
| 默认白名单 | 机器人工作目录 + 媒体目录，固化在代码里                                         | 工作区外的路径（`/etc`、`~/.ssh`、整个家目录） |
| 额外白名单 | 配置项 `media.allowedDirs`（`QQ_MEDIA_ALLOWED_DIRS`），逗号分隔                 | 用户自己的图库 / 语音库                        |
| 软链接判定 | 展开 `~`、相对路径按工作目录解析，再取真实路径判定；词法路径与真实路径都要命中  | 目录内的软链接指向目录外                       |
| 目录边界   | 按目录边界比较前缀                                                              | `/data/qq-bot` 不会命中 `/data/qq-bot-secret`  |
| 普通文件   | 必须是存在的普通文件                                                            | 目录、管道等特殊文件                           |
| 远端地址   | 预检：协议、端口白名单，域名解析出的每个地址都必须是公网；通过后原样交给 NapCat | 让 NapCat 去拉内网地址                         |

- 路径判定放在发送额度之前：路径不合法不占发送额度，模型可以换个文件立刻重发。
- 远端地址由 NapCat 自己去拉，插件不碰文件：NapCat 与插件不必共享文件系统，容器、异机部署照常可用。
- 公网判定用 `ipaddr.js`（`request-filtering-agent` 用的同一个库），规则一致：只有 `unicast` 段算公网，
  回环、私网、CGNAT、链路本地、组播、IPv4-mapped、6to4 一律不算。
- 已知局限：预检解析一次 DNS，NapCat 下载时会再解析一次，中间存在 DNS 重绑定窗口——
  挡得住「地址本身就指向内网」，挡不住「先给公网 IP、后解析到内网」。
- `base64://` 载荷不涉及路径与网络，不受影响。
- 收藏表情用的是 NapCat 自己的地址，不走这条路径。
- 媒体目录从 `/tmp/opencode-qq-bot-media` 迁到 `$XDG_STATE_HOME/opencode-qq-bot/media`
  （未设置时 `~/.local/state/opencode-qq-bot/media`），和日志目录一致；旧目录里的文件自然过期。
- 新增配置项 `media.allowedDirs`（`QQ_MEDIA_ALLOWED_DIRS`），默认为空：除了工作目录与媒体目录，
  其它目录都要显式放开。

落地位置：`src/media-path.ts`、`src/tools/qq.ts`、`src/config.ts`、`src/index.ts`

### B. 功能缺口类

| #   | 条目                | 本项目现状                                                                                      | qq-bridge 对照                                                           | 结论                                                                     |
| --- | ------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| B1  | 冷启动补历史        | 新建绑定时会话是空的，机器人刚进群 / 插件刚装 / 会话被删被重建时对之前一无所知                  | `qq_get_group_history`                                                   | **采纳**（已实现，见第四节）                                             |
| B2  | 缺分对象的记忆存储  | 只有"一个群一个会话"的天然隔离；会话被 compact / 删除 / 重建后事实就只剩摘要                    | `qq_memory_append/query/remove/clear` + `slang-learner`（按 scope 隔离） | **采纳**（方案待商讨，见第五节，优先级低）                               |
| B3  | 无 QQ 侧管理命令    | 群里 `/xxx` 只会进 prompt；插件命令此前只注册在 TUI 侧                                          | `/role` `/silent` `/active` `/status` `/reset`，桥接直接执行不经模型     | **采纳（已实现，见「A4 / B3 / B4 的落地方式」）**                        |
| B4  | 会话无法重置 / 退役 | 绑定后永久复用，上下文持续增长                                                                  | `retireSession()` 全套 + `/api/session/reset`                            | **采纳（已实现，见「A4 / B3 / B4 的落地方式」）**                        |
| B5  | 出站文本质量        | 不做 markdown→纯文本（只在提示词里要求）；`splitMessage` 按码点切，字素簇会被切坏               | `src/md-to-plain.js` + `splitForQQ()` 代理对安全切分                     | **采纳**（已实现）：remove-markdown + Intl.Segmenter，不手写（见第六节） |
| B6  | 失败无兜底文案      | 失败只写日志，群内表现为「不回话」                                                              | `reportTurnFailure()`：统一文案 + 节流，绝不把上游异常原文发到 QQ        | **采纳（已实现，见「B6 的落地方式」）**                                  |
| B7  | 通知事件订阅        | 仅订阅 `message.group.normal` / `message.private`；`notice` / `request` / `meta_event` 一律不接 | 处理撤回通知、戳一戳、成员增减                                           | **采纳（已实现，见第七节）**                                             |

### C. 基础设施类

| #   | 条目                     | 本项目现状                                         | qq-bridge 对照                                                                                                | 结论                                              |
| --- | ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| C1  | 无 CI                    | 无 `.github/`                                      | 3 job：syntax 全量 `node --check` + JSON.parse + 许可证一致性 / privacy-scan / windows 上 npm audit + 59 脚本 | **采纳（已实现，见「C1 / C3 / C4 的落地方式」）** |
| C2  | 无隐私扫描               | 仅靠 `.gitignore` 挡 `.env`/`opencode.json`        | `privacy-scan.mjs` 扫工作树 + **全部 git 历史**（9-10 位 QQ/群号、凭证赋值、PEM、绝对路径）                   | **采纳（已实现，见「C2 的落地方式」）**           |
| C3  | 无安全基线与漏洞报告文档 | docs/ 仅 3 篇                                      | `SECURITY_BASELINE.md`、`SECURITY.md`、`NOTICE.md`（数据流）                                                  | **采纳（已实现，见「C1 / C3 / C4 的落地方式」）** |
| C4  | 无发布流程               | 无 publish 脚本、无 release workflow，版本手工维护 | 有 release 流程                                                                                               | **采纳（已实现，见「C1 / C3 / C4 的落地方式」）** |
| C5  | 日志只有 stdout 且无脱敏 | `src/logger.ts` 仅 console                         | 带上限的日志文件 + 每行脱敏                                                                                   | **采纳（已实现，见「C5 的落地方式」）**           |
| C6  | 配置面窄                 | 仅 groups/users 白名单 + 11 项配置                 | allow/deny 双列表 + ownerQQ + 每会话覆盖                                                                      | **采纳（已实现，见第八节）**                      |

### C5 的落地方式（已实现）

日志改用 [Winston](https://github.com/winstonjs/winston)：console 保留人类可读输出，同时写一份带上限的 JSON 日志文件，每行落盘前统一脱敏。

选 Winston 而不是 Pino：要的是「人类可读 console + 带大小上限的文件输出」两件事同时成立，`winston-daily-rotate-file` 自带 `maxSize` / `maxFiles`，每行脱敏能在 format 管道里统一做；聊天机器人日志量小，性能不是重点。

| 手段     | 做法                                                                                                                      | 补上了什么                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| console  | Winston Console transport，沿用 `[时间] 级别 前缀 正文` 的格式，meta 用 `util.inspect` 展开；error 走 stderr              | 现有调用点一行不用改                 |
| 日志文件 | `winston-daily-rotate-file` 写 JSON，一行一条，`qq-bot-%DATE%.log` 带日期                                                 | 事后可查，不用翻容器日志             |
| 大小上限 | `maxSize`（默认 `5m`）+ `maxFiles`（默认 5），按天滚动                                                                    | 日志不会把磁盘写满                   |
| 目录     | 默认 `$XDG_STATE_HOME/opencode-qq-bot/logs`，未设置则 `~/.local/state/opencode-qq-bot/logs`；不存在自动创建（0700）       | 不用手工 mkdir                       |
| 逐行脱敏 | format 管道最后一步，对**最终序列化后的整行**做一次脱敏                                                                   | message、meta、Error stack 都覆盖到  |
| 复用 A2  | `src/sensitive.ts` 新增 `maskSecrets()`，用 A2 同一套检测器集合（同样排除 email / obfuscated_email / credit_card / iban） | 日志里的凭证不落盘，又不误伤群聊内容 |

- 日志场景是「打码」不是「整条拦截」：命中只把凭证换成 `[REDACTED:<检测器>]`，其余内容照常写。
- 脱敏发生在序列化之后，所以 `meta` 里的 Error stack（多行折成一行后）同样会被覆盖。
- 已知凭证（环境变量里像密钥的值 + `napcat.token`）作为自定义检测器一并参与脱敏。
- 不误伤：普通中文聊天、QQ 号、手机号、邮箱、URL、UUID 原样保留。
- 新增配置 `log.level` / `log.dir` / `log.maxSize` / `log.maxFiles`（`QQ_LOG_LEVEL` / `QQ_LOG_DIR` / `QQ_LOG_MAX_SIZE` / `QQ_LOG_MAX_FILES`）。
- 插件卸载时 `closeLogger()` 等文件流落盘，避免丢掉最后几行。
- 已知限制：`winston-daily-rotate-file` 清理旧文件前会检查文件是否已落盘，启动瞬间的连续写入可能多留几个文件。

落地位置：`src/logger.ts`、`src/sensitive.ts`（`maskSecrets`）、`src/config.ts`、`src/index.ts`

### B6 的落地方式（已实现）

回合失败时不再只是写日志、群里一声不响：模型一句话都还没发出就失败，插件往聊天里补一条固定文案。

| 情形                                          | 群里看到什么                            | 说明                                  |
| --------------------------------------------- | --------------------------------------- | ------------------------------------- |
| `session.execution.failed`                    | `⚠️ 暂时无法处理这条消息，请稍后再试。` | 上游异常原文只进日志（logger 会脱敏） |
| `session.execution.interrupted`               | `⏹️ 已停止`                             | 中断同样可能意味着模型没来得及回话    |
| 同一批消息重试到上限被丢弃                    | 同上第一条                              | 这批内容再也进不了会话，得有个交代    |
| 模型已经调用过发送工具（`awaitingSend` 为假） | 不发                                    | 已经回过话，不再补一条噪音            |
| 主动说话失败                                  | 不发                                    | 主动搭话失败不往群里道歉              |

- 文案写死在 `src/session/manager.ts`（`FAILURE_NOTICE` / `INTERRUPTED_NOTICE`），不带任何上游错误、路径或凭证。
- 节流：同一目标 5 分钟内最多一条（`FAILURE_NOTICE_INTERVAL_MS`），连续失败不会刷屏。
- 提示本身走插件自己的发送通道（`sendPlainMessage` + 限流器），不占用模型发送额度。
- 提示发送失败只写日志，不影响缓存消息的投递。

落地位置：`src/session/manager.ts`（`notifyFailure`、`handleExecutionEnd`、投递上限分支）、`src/index.ts`（注入发送通道）。测试见 `tests/manager.test.ts`。

### A4 / B3 / B4 的落地方式（已实现）

三件一起落地：工具按「发送者角色 + 聊天」分配，管理命令只在 owner 与管理员自己的私聊里生效，会话可以随时重置。
同一组命令也以 `qq-` 前缀注册为 TUI 命令（`/qq-help`、`/qq-reset` 等，见 `src/tui-commands.ts`），
与 QQ 侧共用 `src/commands.ts` 的命令表，避免与 OpenCode 内置命令同名。

| 角色           | 工具配置档                                     |
| -------------- | ---------------------------------------------- |
| owner / 管理员 | `admin`（全开）                                |
| 其他人         | 该群 / 私聊指定的档，未指定用 `defaultProfile` |

```json
{
  "defaultProfile": "chat",
  "profiles": {
    "chat": { "allow": ["websearch", "webfetch", "qq_*"], "deny": [] },
    "admin": { "allow": ["*"], "deny": [] }
  },
  "chats": { "group:100": "chat" }
}
```

- 配置在 `tool-profiles.json`（`toolProfilesPath` / `QQ_TOOL_PROFILES` 可改路径），
  `allow` 就是白名单（没列出的一律不可用），支持 `*`、`qq_*` 通配，`deny` 优先；
  文件缺失或半写时沿用内置默认 / 上一份配置并告警。
- 普通成员默认只放行 `websearch`、`webfetch` 与 `qq_*`：`shell` / `write` / `read` 等本地工具全部拒绝；
  子代理（`subagent` / `task`）也不在白名单里，因为它会开新会话、绕过按聊天过滤。
- 两层执行：`context` 钩子删掉不允许的工具，`execute.before` 再挡一次，Code Mode 与并发调用也绕不过。
- 管理命令只在 `ownerQQ` / `admins` 各自的私聊里生效（发送者必须是私聊主人）：`/help`、`/status`、`/tools [目标]`、
  `/reset`（不带参数列出所有聊天）/ `/reset group:123`。群聊、其他人的私聊、未知 `/xxx` 都照常交给模型。
- `/reset` 不带参数时只列出放行名单里的聊天及 `group:<id>` / `private:<id>` 写法，不执行重置；
  带目标时才动手，名单外的目标直接拒绝。若上游正在执行，先 `interrupt` 再删除会话；
  下一条消息新建会话并正常补历史。
- 子代理是独立会话，`targetForSession` 查不到绑定；因此 QQ 会话里创建子代理一律拒绝，
  即使 admin 档放行也不会开出不按聊天收窄的子会话。

落地位置：`src/tools/policy.ts`、`src/tools/policy-guard.ts`、`src/commands.ts`、
`src/session/manager.ts`（`resetTarget`）、`src/index.ts`。测试见 `tests/policy.test.ts`、
`tests/commands.test.ts`、`tests/manager.test.ts`。

### C1 / C3 / C4 的落地方式（已实现）

三个基础设施项一起落地，共用一套门禁：本地 `bun run ci`、CI 里同样的命令、发布前再跑一遍。

| #   | 落地                                                                                                                                                                                  | 位置                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| C1  | GitHub Actions 一个 job：隐私扫描 → 冻结安装 → `tsc --noEmit` → `eslint .` → `prettier --check .` → `vitest run`（含 NOTICE 一致性用例）→ `bun audit --production --audit-level=high` | `.github/workflows/ci.yml`                                                     |
| C3  | 根目录 `SECURITY.md`（私密上报、无 SLA、范围与部署硬要求）+ 安全基线（信任边界、数据流、不变量清单，每条带实现与测试落点）+ `NOTICE` 数据流小节                                       | `SECURITY.md`、`docs/security-baseline.md`、`NOTICE`                           |
| C4  | tag `v*` 触发：`verify` 跑完整门禁与 `release-check`，`publish` 把包 `npm stage publish` 到暂存区并按 CHANGELOG 段创建 GitHub Release；维护者 2FA 批准后才可安装                      | `.github/workflows/release.yml`、`scripts/release-check.ts`、`docs/release.md` |

- 许可证 / NOTICE 一致性只写一次：`tests/notice.test.ts`，CI 跑全量测试时一并执行。
- 隐私扫描是同一个 job 里的独立步骤，放在 `bun install` 之前：此时没有 `node_modules`，
  不会把依赖里的字符串当泄漏；历史扫描需要完整克隆，checkout 用 `fetch-depth: 0`。
- 只跑 ubuntu：Windows 路径差异留到真正出问题时再加，避免 CI 时间翻倍。
- 版本号仍手工维护；`release-check` 只校验、不改写，也不自动提交。
- `0.4.0` / `0.5.0` 从未发布到 npm，`0.5.1` 是 npm 上第一个带上它们内容的版本。
- 发布凭据走 npm trusted publishing（GitHub OIDC），工作流把 npm 固定到 `11.15.0`，不需要长期 token；
  信任关系是 stage-only：CI 只能 `npm stage publish`，维护者用 2FA 执行 `npm stage approve` 后版本才上线。

### C2 的落地方式（已实现）

用 [TruffleHog](https://github.com/trufflesecurity/trufflehog) 的自定义检测器，不自己写扫描脚本：
自定义正则足够覆盖「群号 / 凭证赋值 / PEM」这类文本规则，命中判定、去重、退出码都交给它。

| 检测器                   | 抓什么                                                     | 关键词           |
| ------------------------ | ---------------------------------------------------------- | ---------------- |
| `QQGroupNumber`          | `"groups": [123456789]`（配置与 JSON 写法）                | `groups`         |
| `QQGroupNumberEnv`       | `QQ_GROUPS=123456789`（环境变量写法）                      | `groups`         |
| `QQGroupNumberAssertion` | `expect(config.groups).toEqual([123456789])`（测试断言）   | `groups`         |
| `CredentialAssignment`   | `token` / `secret` / `password` / `api_key` 等赋了非占位值 | 同左             |
| `PrivateKeyBlock`        | `-----BEGIN ... PRIVATE KEY-----`                          | `private`、`key` |

- 规则在 `scripts/trufflehog.yml`，关键词和正则必须在同一段文本里同时命中才触发。
- RE2 没有前后瞻，也没有语义判断：群号要按写法各写一条正则；实测 `toEqual([...])` 这种
  写法不单独写规则就会漏。规则不能按路径限定，只能靠 `exclude_words` 和 `trufflehog:ignore`。
- 离线跑：`--no-verification`，所有结果都是 unverified，所以不能加 `--results=verified`
  （那会把自定义结果全部过滤掉）。
- CI 固定 `v3.99.8` 并用官方 action 跑；`version` 输入也写死 `3.99.8`（它默认 `latest`，不写就会漂）。
- CI 扫的是本次 push / PR 的提交范围；本地 `bun run privacy:scan` 扫全部历史，规则同一份。
- `--include-detectors=CustomRegex` 只跑自定义检测器，不掺内置检测器的噪音；
  `--fail` 由 action 自带，命中时退出码 183。
- 已接受的例外写进 `exclude_words`：首个提交里那个已确认公开的历史群号（`README.md`、
  `opencode.json`、`tests/config.test.ts`，之后已删除但仍在历史里），以及测试里的假凭证。
  不重写历史。
- 没做的两件事：绝对路径规则（这个仓库里意义不大）、`git ls-files` 白名单式检查
  （TruffleHog 没有「文件是否被跟踪」的能力，自研脚本暂不做）。

### A4 的平台落点

先分清两件事：

| 事项              | 现状                                                      | 性质           |
| ----------------- | --------------------------------------------------------- | -------------- |
| 拦内置 `question` | 它会在 TUI 弹出选择框；QQ 侧没人能应答，会话会一直等下去  | **必要**，保留 |
| 其余工具的处置    | 按发送者角色与聊天收窄，普通成员默认只留联网工具与 `qq_*` | **已实现**     |

qq-bridge 的两层闸门在 OpenCode V2 插件 API 里都有对应原语，不必手写整套工具名白名单：

| qq-bridge                                      | OpenCode V2 插件 API                                                                                        | 作用域 |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------ |
| 注册期 `ctx.tools.restrict`（藏掉一批工具）    | `ctx.tool.transform((editor) => editor.remove(id))`                                                         | 全局   |
| 执行期白名单（`SAFE_PREFIXES` / `SAFE_EXACT`） | `ctx.permission.hook("evaluate")`：事件带 `sessionID` + `action`，可设 `effect`（`allow` / `deny` / `ask`） | 按会话 |

关键差别：**注册期移除是全局的**（会影响非 QQ 会话），所以没有走注册期，改为按会话判定。

最终采用两层：

1. **上下文层**：`ctx.session.hook("context")` 的 `event.tools` 是按会话可改的，
   每轮按发送者角色与聊天过滤一次，模型看不到不允许的工具。
2. **执行层**：`ctx.tool.hook("execute.before")` 对正在执行 QQ 轮次的会话再挡一次，
   Code Mode、并发调用与直接指定工具名都绕不过去。

没有用 `ctx.tool.transform`（全局，会波及非 QQ 会话）；也没有用 `ctx.permission`——
当前插件 API 里那个钩子不承担工具白名单语义，执行前拦截才是确定生效的位置。

---

## 三、已确认缺陷（不是候选改进项，是要修的 bug）

### D1. 只含 QQ 官方表情的消息被整条丢弃（已修复）

`shouldProcess` 的白名单只列了 `text` / `image` / `record` / `forward` / `reply`，
其余段类型一律返回 false。群里发一个表情（`face`）就落在这个空档里——
渲染器本身是支持 `face` 的（`renderFace`），但消息在进渲染器之前就被门卫挡掉了。

- 后果：模型看不到群里的纯表情消息，节奏判断会偏。
- 同理：只含 `at`（@ 别人且没有文字）的消息也被丢弃；`video` / `audio` / `file` /
  `json` / `xml` / `markdown` 同样落在空档里。

**修复**：门卫改成按"渲染器能产出文本的段类型"放行（`RENDERABLE_SEGMENT_TYPES`），
与 `renderMessage` / `renderForwardSegments` 的分支一一对应，空文本仍是唯一的丢弃条件。
`tests/render.test.ts` 用同一份段类型清单断言门卫放行 + 渲染器出文本，防止两边再次跑偏。

位置：`src/naplink/render.ts`

---

## 四、B1 冷启动补历史

**场景**：新建绑定时会话是空的。机器人刚进群、插件刚装上、OpenCode 会话被删或被重建，
模型对"之前发生了什么"一无所知。NapCat 侧仍保留着最近的消息记录，可以补。

**实现**：每个目标在本次运行的第一轮消息投递前**一次性**补齐历史，
以 `<history>` 文本块拼在首轮消息前面，不新增工具面，也不额外触发模型调用。

- 新建会话：补最近 `history.count` 条（默认 20）。
- 重启后复用上次的会话：读出上次投递到的位置，从最新往回翻页，翻到该位置或达到条数上限为止，
  只补重启期间错过的增量。
- 图片会下载进会话并共用首轮的图片预算，语音会转写；群公告、成员变动等非消息事件不补。
- 补不满时不做说明，能补多少算多少。
- 群聊与私聊都补；历史条数由 `history.count`（`QQ_HISTORY_COUNT`）控制，`0` 表示关闭。

位置：`src/naplink/history.ts`、`src/session/manager.ts`

---

## 五、B2 分对象的记忆存储（待商讨，优先级低）

**缺口**：本项目的"记忆"目前只等于 OpenCode 会话本身。会话被 compact、被删除或被重建，
这段聊天的事实就只剩摘要或者没有了。缺的是一份**按 QQ 目标划分、生命周期长于会话**的存储。

**约束**：

1. **隔离**：群 A 的记忆不能出现在群 B；私聊记忆不能进群。
2. **归属**：记忆属于 QQ 目标（群号 / 私聊号），不是属于 OpenCode 项目或会话。
3. **存活**：会话压缩、重建、插件重启后仍在。
4. **留存**：聊天内容落盘 → 需要保留期与清理策略。

**候选实现**：

| 方案                              | 说明                                                                                 | 代价                               |
| --------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------- |
| A 插件自持存储                    | `ctx.storage` 按目标键存，`qq_memory_append/query/remove` 工具，查询自动限定当前目标 | 与 opencode-mem 重复；多一套数据面 |
| B 复用 opencode-mem，命名空间注入 | 插件在提示 / 工具层注入目标键前缀，存储交给 opencode-mem                             | 隔离靠模型自觉，不可靠             |
| C 包装 opencode-mem 接口          | 插件侧强制注入作用域                                                                 | 耦合第三方 API                     |
| D 不新增存储，靠会话承载          | 现状                                                                                 | 压缩后丢失，正是缺口本身           |

**待定问题**：记忆的内容形态（自由文本 / 条目 / 带时间戳）、写入时机（模型主动调用 vs 插件自动摘要）、
保留期与删除、是否允许用户查看与编辑、与 opencode-mem 的分工。

---

## 六、B5 出站文本质量：选型（不手写）

按 AGENTS.md 的要求，能用现成轮子就不自己实现。B5 分成两半，各有对应的成熟方案：

### 6.1 markdown → 纯文本

用 [`remove-markdown`](https://github.com/zuchka/remove-markdown)（npm `remove-markdown`）。

| 事实 | 值                                                              |
| ---- | --------------------------------------------------------------- |
| 版本 | 0.8.0（2026-10 发布）                                           |
| 许可 | MIT                                                             |
| 热度 | GitHub 379 star / 74 fork；npm 月下载约 537 万                  |
| 维护 | zuchka 自 2023 年接手（原作者 Stian Grytøyr），197 次提交       |
| 形态 | CJS + ESM + Deno，自带 TypeScript 类型                          |
| 覆盖 | 标题、粗斜体、列表、引用、围栏代码、行内代码、删除线、HTML 标签 |

实测行为（`bun` + 0.8.0）与需要取舍的点：

| 输入                | 默认输出               | 可选配置                                    |
| ------------------- | ---------------------- | ------------------------------------------- |
| `# 标题`            | `标题`                 | —                                           |
| `- 第一项`          | `第一项`               | `listUnicodeChar: "•"` → `• 第一项`         |
| `1. 第一`           | `第一`                 | 同上（有序无序都变 `•`）                    |
| `[链接](url)`       | `链接`                 | `separateLinksAndTexts: ": "` → `链接: url` |
| `![图](url)`        | `图`                   | 与 `replaceLinksWithURL` 同开 → `!图: url`  |
| `> 引用`            | `引用`                 | —                                           |
| ` ```js ... ``` `   | 保留代码正文           | —                                           |
| `~~删除~~`          | `删除`                 | —                                           |
| `<b>html</b>`       | `html`                 | `htmlTagsToSkip` 可保留指定标签             |
| `2 * 3 * 4 = 24`    | 原样保留（不误判斜体） | —                                           |
| `\| a \| b \|` 表格 | **原样保留**           | 轮子不处理表格，需要单独决定                |

**取舍（已定）**：

| 问题       | 决定               | 实现                                                               |
| ---------- | ------------------ | ------------------------------------------------------------------ |
| 链接与图片 | 保留 URL           | `separateLinksAndTexts: ": "`；图片先降级成普通链接，去掉 `!` 前缀 |
| 列表符号   | 全部去掉，只留正文 | `stripListLeaders: true` + `listUnicodeChar: ""`                   |
| 表格       | 整块丢弃           | 剥离前先按「含管道符的行 + 分隔行」识别整块删掉                    |
| 许可声明   | NOTICE 文件        | 收录全部直接依赖的 MIT 版权声明，随包分发                          |

### 6.2 字素簇安全切分

现状：`src/tools/qq.ts` 的 `splitMessage` 用 `Array.from` 按**码点**切——代理对（UTF-16 半区）已经是安全的，
但**字素簇**不安全：ZWJ emoji 序列（👨‍👩‍👦）、肤色修饰符（👍🏻）、区域指示符旗帜（🇨🇳）、组合字符（é = e + ◌́）会被切坏。

用内置的 [`Intl.Segmenter`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter)
（`granularity: "grapheme"`）按字素簇切，Node 与 bun 都原生支持，不需要新增依赖：

```ts
const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" })
```

### 6.3 落地情况

新增 `src/outbound.ts`，两半合在一起：

| 函数              | 作用                              |
| ----------------- | --------------------------------- |
| `toPlainText`     | 丢表格 → 图片降级 → 剥离 markdown |
| `splitMessage`    | 按字素簇切分，保留换行与空行      |
| `prepareOutbound` | 出站内容的统一入口：先剥离再切分  |

**作用范围**：只有模型产出的文本走剥离——`qq_send_message` 的 content 与 `qq_send_forward` 的节点文本。
插件自己生成的提示文本（`sendPlainMessage`，如收藏表情列表）保持原样，
否则 `1. 猫猫摊手` 这样的编号会被当成有序列表符号吃掉。
剥离后内容为空（例如只回了一张表格）时按「已读不回」处理，不再发空消息。

---

## 七、B7 通知事件订阅：可配置项（已实现）

**原先**：`src/index.ts` 只挂了两个消息事件（`message.group.normal` / `message.private`）。
NapLink 已经把事件按 `post_type` + `notice_type` 拆好并分发，但插件只消费消息类。

**落地方式**：

| 配置项             | 环境变量             | 默认值    | 说明                                  |
| ------------------ | -------------------- | --------- | ------------------------------------- |
| `events.subscribe` | `QQ_EVENT_SUBSCRIBE` | `message` | 订阅的事件类别：`message` / `notice`  |
| `events.notices`   | `QQ_EVENT_NOTICES`   | `[]`      | `notice` 里关心哪些通知，留空表示全收 |
| `events.inject`    | `QQ_EVENT_INJECT`    | `true`    | 通知是否注入会话上下文                |

- 类别列表与通知列表都用逗号分隔；写错的类别被忽略并告警，不会静默失效。
- `events.notices` 可写通知类型（`group_recall`），也可写类型加子类型（`notify.poke`）。
- 默认只订阅 `message`：升级插件不会突然多出行为。

**支持的通知类型**（NapCat 实际推送的 `notice_type`）：

| 通知                                | 注入上下文里的说法            |
| ----------------------------------- | ----------------------------- |
| `group_recall` / `friend_recall`    | 有消息被撤回（不复述内容）    |
| `group_increase` / `group_decrease` | 有人加入 / 退出 / 被移出群    |
| `group_admin`                       | 有人被设为 / 被取消管理员     |
| `friend_add`                        | 新增好友                      |
| `group_upload`                      | 群里有人上传了文件            |
| `notify.poke` / `notify.gray_tip`   | 有人戳了一下 / 群里有一条灰条 |

**行为**：

- 通知只写日志与上下文，**不自己发起一轮对话**：下一轮该聊天的上下文里附带一段
  「聊天里发生过的通知（不需要回复）」。
- 通知同样受准入名单限制，不在放行名单里的群不会被处理。
- 撤回类通知只说明「有消息被撤回」，不复述被撤回的内容。
- 每个聊天最多缓存 20 条、等待 30 分钟，超时的通知不再注入。
- 文件名、灰条内容等外部文本先净化再写进上下文。

**本版不做**：请求类事件（好友申请 / 加群申请）、`meta_event` 心跳、撤回的本地标记
（模型可能已经读过被撤回的内容，这里不做「已撤回」状态维护）。

---

## 八、C6 配置面扩展（已实现）

**原先**：`groups` / `users` 两个白名单 + 全局一套工具配置，配置面窄；
每个群要不要被唤醒、用哪个模型和角色设定，只能改代码。

**落地方式**：

| 配置项                     | 环境变量                  | 默认值                        | 说明                                       |
| -------------------------- | ------------------------- | ----------------------------- | ------------------------------------------ |
| `access.allow.groups`      | `QQ_ALLOW_GROUPS`         | `[]`                          | 放行的群号                                 |
| `access.allow.users`       | `QQ_ALLOW_USERS`          | `[]`                          | 放行的私聊 QQ 号                           |
| `access.deny.groups`       | `QQ_DENY_GROUPS`          | `[]`                          | 拒绝的群号，优先于放行名单                 |
| `access.deny.users`        | `QQ_DENY_USERS`           | `[]`                          | 拒绝的私聊 QQ 号，优先于放行名单           |
| `access.allowAllWhenEmpty` | `QQ_ALLOW_ALL_WHEN_EMPTY` | `false`                       | 放行名单为空时是否放行全部目标             |
| `ownerQQ`                  | `QQ_OWNER_QQ`             | 未设置                        | 所有者的私聊永远放行，管理命令只在这里生效 |
| `chatOverridesPath`        | `QQ_CHAT_OVERRIDES`       | `""`（`chat-overrides.json`） | 每会话行为覆盖文件路径                     |

**判定顺序**：owner 的私聊永远放行 → deny 命中拒绝 → allow 非空只放行名单 →
否则按 `allowAllWhenEmpty`。owner 出现在 deny 名单里会被豁免并告警。

**每会话覆盖**（`chat-overrides.json`，键是 `group:100` / `private:200`）：

| 字段        | 说明                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------- |
| `wake`      | `all` 每条必回 / `mention` 被 @ 必回（默认）/ `prefix` 前缀命中必回 / `none` 完全不理群消息 |
| `prefix`    | 唤醒前缀，`wake` 为 `prefix` 时用                                                           |
| `proactive` | 是否允许主动说话，`false` 表示这个聊天不主动开口                                            |
| `agent`     | 覆盖该聊天使用的 OpenCode agent                                                             |
| `model`     | 覆盖该聊天使用的模型，格式 `provider/model[/variant]`                                       |
| `soul`      | 覆盖该聊天使用的角色设定文件路径                                                            |

- 唤醒结果写进提示词：命中时明确要求模型回复，没命中时允许它不回复。
- `agent` / `model` 在会话建立时生效；覆盖变化时对已有会话调用
  `switchAgent` / `switchModel` 切换，值没变就不切。
- `soul` 按 mtime 热加载，相对路径按当前工作目录解析。
- 旧的 `QQ_TARGET_GROUPS` / `QQ_TARGET_USERS` 与插件选项 `groups` / `users` 已移除，
  检测到就给出迁移提示。

**本版不做**：群管理员提权分级、忽略 @all、群内首段 @别人不唤醒、按会话的概率覆盖。

---

## 九、评审记录

| #   | 结论               | 备注                                                           |
| --- | ------------------ | -------------------------------------------------------------- |
| A1  | 采纳（已实现）     | 出站速率限制：每分钟 / 每小时硬上限 + 相邻发送最小间隔         |
| A2  | 采纳（已实现）     | 出站敏感信息 / 令牌拦截：flare-redact + 已知凭证分片           |
| A3  | 采纳（已实现）     | 群消息注入净化：结构净化 + 绝对时间标注                        |
| A4  | 采纳（已实现）     | 拦 question 保留；其余工具按角色 / 聊天收敛，执行前二次拦截    |
| A5  | 采纳（已实现）     | SSRF 判定加固：连接级 IP 判定 + 端口白名单 + 不跟随跳转        |
| A6  | 采纳（已实现）     | 媒体路径白名单：工作区 + 媒体目录 + 配置放开                   |
| B1  | 采纳（已实现）     | 一次性冷启动补历史，不做回看工具                               |
| B2  | 采纳（方案待商讨） | 分对象记忆存储，优先级低                                       |
| B3  | 采纳（已实现）     | QQ 侧管理命令：仅 owner 私聊，/help /status /tools /reset      |
| B4  | 采纳（已实现）     | /reset 先打断再删会话，下一条消息重开并补历史                  |
| B5  | 采纳（已实现）     | remove-markdown + Intl.Segmenter，不手写                       |
| B6  | 采纳（已实现）     | 失败兜底文案：固定提示 + 5 分钟节流，上游异常原文只进日志      |
| B7  | 采纳（已实现）     | 通知事件订阅做成可配置项：只记日志并注入上下文，不自己起一轮   |
| C1  | 采纳（已实现）     | CI：单个 job 跑类型 / Lint / 格式 / 测试 / audit，ubuntu-only  |
| C2  | 采纳（已实现）     | TruffleHog 自定义检测器扫全部历史，CI 拦截群号 / 凭证 / PEM    |
| C3  | 采纳（已实现）     | SECURITY.md + 安全基线 + NOTICE 数据流                         |
| C4  | 采纳（已实现）     | tag 触发：校验后 stage 到 npm + GitHub Release，2FA 批准后上线 |
| C5  | 采纳（已实现）     | 日志脱敏：Winston 日志文件（带上限）+ 逐行脱敏                 |
| C6  | 采纳（已实现）     | 配置面扩展：allow/deny 双列表 + owner 豁免 + 每会话行为覆盖    |
