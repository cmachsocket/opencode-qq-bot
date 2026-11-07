# 提交审计：cb7bb0b..7a3a106

> 状态：审计完成，未改动代码。范围内 10 个提交，发现 3 个中危、5 个低危问题。

审计范围：`cb7bb0bae7c5fac1d47ae3cfce0f9f3008984edb` 及其之后的提交，直到 `7a3a106`。
更晚的提交另见 [commit-audit-7a3a106.md](./commit-audit-7a3a106.md)
与 [commit-audit-c90b2bc.md](./commit-audit-c90b2bc.md)。

| 提交      | 内容                                                     |
| --------- | -------------------------------------------------------- |
| `cb7bb0b` | 新增 `src/naplink/media.ts`，QQ 图片落临时文件           |
| `06e149d` | 文档：图片文件引用与清理说明                             |
| `b26d0fa` | 群聊与私聊支持（新增 `src/chat.ts`）                     |
| `129370b` | 新增 `src/instance.ts`，重载时释放旧插件实例             |
| `a7892de` | 发布 0.2.0                                               |
| `c0ef3b7` | 新增 `src/tools/ask-guard.ts`，QQ 会话禁用 question 工具 |
| `a3faf14` | 新增 `src/session/soul.ts`，可切换角色设定并热重载       |
| `60ec628` | 发布 0.3.0                                               |
| `e801095` | 水合媒体段时保留远程 URL（替换 SDK 的 `hydrateMessage`） |
| `4b6a888` | 调整发送工具的输出                                       |

验证基线：`tsc --noEmit` 通过，`eslint .` 无告警，`vitest run` 18 个文件 / 295 个用例全绿。

上游核对：`packages/core/src/plugin/hooks.ts`（hook 失败语义）、
`node_modules/@opencode/plugin/dist/promise/tool.d.ts` 与 `promise/registration.d.ts`
（tool hook 类型）。

---

## 中危

### 1. 实例注册表只有一个槽位，多项目场景下旧实例不会被释放

`src/instance.ts:21-34` 的注册表在 `globalThis` 上只保留**一个** `active` 槽位
（`state.active = { key, instance }`）。`claimInstance()`（`src/instance.ts:41-49`）只有当
`state.active?.key === key` 时才把旧实例作为 `previous` 返回，而 `src/index.ts:48`
无条件用新实例覆盖 `state.active`。

后果：同一 OpenCode 进程里同时加载两个项目（目录不同）时，后加载的项目会顶掉前一个的槽位；
前一个项目下次重载时 `key` 对不上，`previous` 为 `undefined`，**旧实例永远不会被 dispose**——
NapCat 的反向 WebSocket 保持连接，消息被重复消费与重复投递（`b27741c` 的跨进程锁只按
NapCat 端点 + 令牌区分，无法覆盖同进程内的重复实例）。

另外 `src/index.ts:53` 的 key 是 `${ctx.location.directory}\n${config.napcat.url}`，
不含令牌：同一目录、同一 URL 但令牌不同的两个机器人会被当成同一个实例，互相 dispose。

建议：注册表改为按 key 存 Map；key 里补上令牌；`claimInstance` 返回的 `previous` 应对同 key
的全部实例做释放。

位置：`src/instance.ts:21-49`，`src/index.ts:48,53-60`

### 2. `qq_send_image` / `qq_send_record` 不校验 `file`，NapCat 主机可被要求外发任意本地文件

`src/tools/qq.ts:229-254` 与 `src/tools/qq.ts:311-331` 把 `file` 原样透传给 NapCat
（`{ type: "image", data: { file } }` / `{ type: "record", data: { file: input.file } }`），
没有目录白名单、没有 URL 协议限制。NapCat 收到后会在**它自己的机器上**读取该路径并发送到群里。

触发面：群消息文本完全由群友控制（`b26d0fa` 起），模型可能��注入诱导调用该工具；
`requireTarget`（`src/tools/qq.ts:120-132`）只要求会话处于活跃 QQ 回合，不限制路径。

这是 `docs/comparison-qq-bridge.md` 里 A6 已登记的边界，至今未做限制。

建议：把 `file` 限制在插件自己的媒体目录与工作区内，或只允许插件自己落盘的文件引用
（`src/naplink/media.ts` 已经产出 `file:` 引用，可直接复用）。

位置：`src/tools/qq.ts:229-254,311-331`，`src/tools/qq.ts:120-132`

### 3. `isPrivateHost` 不做 DNS 解析，内网 SSRF 仍然可达

`src/naplink/media.ts:92-112` 只按字面判断主机名，`src/naplink/media.ts:218` 据此拒绝请求。
缺口有三处：

- 不解析 DNS：域名解析到 `127.0.0.1` 或 `169.254.169.254` 时会被当成公网地址放行；
- 不覆盖 `100.64.0.0/10`（CGNAT）、`198.18.0.0/15`、`::ffff:127.0.0.1` 这类 IPv4-mapped、
  NAT64 与 6to4 形式——`parts.length !== 4` 时直接判定为公网；
- 不限制端口，也没有禁止明文 `http`。

这也是 `docs/comparison-qq-bridge.md` 里 A5 已登记的边界。

建议：解析 A/AAAA 记录后逐个校验私网段，拒绝解析结果含私网地址的请求；限制端口与协议。

位置：`src/naplink/media.ts:92-112,206-259`

---

## 低危 / 提示

- **`data:` URL 信任声明的 MIME**：`src/naplink/media.ts:153-163` 直接采用 URI 里声明的
  `image/*` 类型，不做魔数嗅探；声明成 `image/svg+xml` 的内容会被存成 `.bin`，
  声明与真实内容不符时也会按声明存盘。
- **媒体目录全局共享**：`src/naplink/media.ts:308-313` 把根目录固定为
  `tmpdir()/opencode-qq-bot-media`，所有项目与实例共用；`src/naplink/media.ts:284-304`
  的 `cleanup()` 会按 7 天 TTL 删除文件，可能删掉别的实例仍在引用的图片。
  建议按实例或项目分目录，或把 TTL 拉长并在删除前检查引用。
- **每条消息水合两次**：`src/index.ts:195` 先调用 `client.hydrate(event.message)`，
  `src/naplink/render.ts:396-407` 又对每个图片段调用 `hydrateSegment`；
  后者因为 `url` 已存在而变成空操作，但第一次调用对所有段都发了请求。
- **question 工具按会话拦截，不区分发起方**：`src/tools/ask-guard.ts:25-31` 只要会话绑定了
  QQ 目标就拒绝 `question`，人工在 TUI 里驱动同一个会话时同样被拒。
- **只读工具不受目标约束**：`qq_favorite_list`（`src/tools/qq.ts:256-269`）与
  `qq_get_login_info`（`src/tools/qq.ts:490-501`）不调用 `requireTarget`，任何会话都能调用；
  其中 `qq_favorite_list` 输出的标签是未净化的第三方描述（见
  [commit-audit-7a3a106.md](./commit-audit-7a3a106.md) 的高危 1），
  会进入人工会话的提示词。

---

## 核对通过的部分

- **工具授权模型合理**：`requireTarget`（`src/tools/qq.ts:120-132`）同时校验
  会话是否绑定 QQ 目标、目标是否仍在配置内、是否存在进行中的回合；
  `hasActiveTurn`（`src/session/manager.ts:321-323`）依赖的 `state.current`
  在成功与失败路径上都会被清除（`src/session/manager.ts:518,526,546,584,622,653,793,799,809`），
  授权窗口不会残留。
- **删除与语音转写已收敛作用域**：`qq_delete_message` 只允许删自己发的消息
  （`manager.isOutgoing`），`qq_fetch_ptt_text` 只允许处理已知消息
  （`src/session/manager.ts:371-376`，出站 ∪ 入站）。
- **媒体落盘的基本防护到位**：5MB 流式上限（`src/naplink/media.ts:114-145`）、
  `redirect: "error"`、15s 超时（`src/naplink/media.ts:223-259`）、
  魔数嗅探 MIME（`src/naplink/media.ts:42-72`）、目录 `0o700`、文件 `0o600`
  （`src/naplink/media.ts:181,267-271`）、按 sha256 内容寻址去重
  （`src/naplink/media.ts:267`）。
- **ask-guard 的拦截语义正确**：上游 `packages/core/src/plugin/hooks.ts` 明确
  “Only tool execute.before may fail: a Tool.Error rejects the call before it runs”，
  钩子抛错即可在执行前拒绝调用；SDK 侧 `Hooks<Spec>` 允许回调抛出
  （`node_modules/@opencode/plugin/dist/promise/registration.d.ts`）。
- **角色设定热重载可靠**：`src/session/soul.ts` 监听所在目录（编辑器替换文件也能触发）、
  150ms 去抖、读取失败有告警（`src/session/soul.ts:115-118`）；
  `findSoulFile` 向上最多 5 层查找 `souls/`。
- **水合不会覆盖远程地址**：`src/naplink/client.ts` 的 `hydrateSegment` 只在缺少 `url` 时补齐，
  忽略 `file:` / `base64:` / `data:` 形式的地址。
- **目标解析有校验**：`src/chat.ts` 的 `parseTargetKey` 校验类型与正整数 ID，
  `isTargetEnabled` 以配置里的群/好友列表为准。

---

## 与其它审计的关系

三份审计覆盖同一条链路的不同环节：

- 本文件中危 2、3（A6 / A5 边界）属于**出站**面：模型可让 NapCat 主机读本地文件、可让插件
  打内网；[commit-audit-c90b2bc.md](./commit-audit-c90b2bc.md) 的高危 1、2 属于**入站**面：
  提示词注入与消息重复。
- 本文件中危 1（单槽实例表）与
  [commit-audit-7a3a106.md](./commit-audit-7a3a106.md) 的中危 4、6、7（抢锁竞态、锁心跳窗口、
  释放顺序）都指向"多实例 / 多项目"这一类问题，建议合并成一次改造：
  实例注册表改为按 key 的 Map，锁的 stale 放宽，卸载路径对每一步单独兜底。

跨三份审计的建议修复顺序：

1. 入站净化两处缺口（逐段净化、表情描述未净化）
2. 投递可靠性两处缺口（`pending` 无上限、历史补页缺 `reverse_order`）
3. 出站边界两处（`file` 不校验、`isPrivateHost` 不解析 DNS）
4. 多实例治理（实例注册表、抢锁竞态、锁心跳、释放顺序）
5. 许可合规、出站丢内容、文档补登与低危项
