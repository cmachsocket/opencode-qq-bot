# 配置中心与状态面板

> 状态：已实现。Svelte 单页应用接管全局配置的查看与修改，并提供机器人运行状态的实时面板；落地细节见文末「落地说明」。

## 目标

1. **自动发现**：新增或删除一个配置项，前端表单自动跟着变，不改任何前端代码。
2. **单一配置源**：全局配置只存在于 `workspace/config.json`；`opencode.json` 不再是配置来源（只保留 `agent` 一项），环境变量也不作为配置来源。
3. **状态可视**：连接状态、会话队列、限流用量、调用链追踪、日记调度实时可见，不必去翻日志。
4. **不做向后兼容**：旧的环境变量、旧的选项别名一律删除，不留兼容层，不做迁移工具与对照表。

## 现状与障碍

### 配置定义散落四处

`src/config.ts` 里同一份配置写了四遍：

| 位置                                                                             | 内容                 |
| -------------------------------------------------------------------------------- | -------------------- |
| `DEFAULT_CONFIG`（`src/config.ts:234`）                                          | 默认值               |
| `createConfigSchema()`（`src/config.ts:375`）                                    | zod 校验、告警与回退 |
| `ENV_VARS`（`src/config.ts:798`）                                                | 70 个环境变量名      |
| `OPTION_KEYS` / `NESTED_OPTION_KEYS`（`src/config.ts:871`、`src/config.ts:901`） | 允许的插件选项键     |

漏改任意一处，配置项会静默失效。`tests/docs.test.ts` 已经在盯 `.env.example` 与 README 的同步，但代码内部的这四处仍靠人工保持一致。

### 插件没有可用的 HTTP 入口

插件运行在 OpenCode 进程内，只能通过 `ctx` 的 domain 拿数据，没有注册 HTTP 路由的接口。面板需要自带服务。

### 配置来源与生效时机

插件读的是 `process.env` 与启动时的插件选项，改文件不会自动生效。要让面板的保存真正有意义，必须同时解决「配置存哪」和「哪些字段能热更新」。

## 总体架构

```
OpenCode 进程
└── qq-bot 插件实例
    ├── src/config/fields.ts      配置字段注册表（单一事实源）
    ├── src/config/registry.ts    由注册表生成默认值 / zod / 文件键集合 / JSON Schema
    ├── src/config/store.ts       读写 workspace/config.json
    ├── src/panel/server.ts       HTTP 服务 + 静态资源托管
    ├── src/panel/api.ts          JSON API 路由
    ├── src/panel/status.ts       运行状态快照采集
    └── web/dist/                 Svelte 构建产物（随 npm 包分发）
```

前端是独立工程 `web/`，构建产物进 npm 包的 `files`。插件用 `node:http` 起服务，不依赖 Bun 运行时。

## 配置模型

### 配置文件

路径：`workspace/config.json`，即机器人工作目录下的 `config.json`（工作目录固定为 `$XDG_DATA_HOME/opencode-qq-bot/workspace`）。与 `chat-overrides.json`、`tool-profiles.json` 同级。

```jsonc
{
  "napcat": { "url": "ws://127.0.0.1:3001", "token": "…" },
  "access": { "allow": { "groups": [123], "users": [] } },
  "log": { "level": "info" },
  "diary": { "enabled": true, "summaryTime": "23:30" },
}
```

- **只存显式值**：文件里没写的字段表示「未配置」，走默认值。不把默认值全量写进去，避免文件被默认值淹没，也让「清空某字段」等价于删除该键。
- 结构沿用现有配置对象的嵌套形状，现有 zod schema 可以直接复用，不需要第二套解析逻辑。
- 文件格式当前不带版本号：字段注册表就是格式的唯一事实源，需要迁移时再引入版本键。未知字段保留原样并告警，不静默丢弃。
- 文件权限 `0600`，目录 `0700`；写入用 `write-file-atomic`（临时文件 + fsync + rename，`mode: 0o600`，同路径并发写自动排队），并保留一份 `.bak`。
- `config.json` 只有插件进程一个写者（面板也在同一进程内），不需要额外的文件锁；仓库里已有的 `@bybrave/proper-lockfile2` 是机器级实例锁，语义不同，不复用。

### 配置来源

`workspace/config.json` 是唯一来源，文件里没写的字段走默认值。

- **`opencode.json` 不再是配置来源**：插件选项整体退出配置体系，只保留 `agent` 一项——agent 是 OpenCode 侧的路由语义（要哪个 agent 会话），继续写在 `opencode.json` 里；`config.json` 不存 `agent`，两边不重复。其余插件选项键一律忽略，不生效也不告警。
- **模型是配置项，偏好写进 `config.json`**：可用模型列表由 OpenCode 提供（`opencode.json` 的 provider 配置 + 模型目录），那是「有哪些模型」；「用哪个模型」是用户偏好，属于 `config.json` 的 `model` 字段。所以 `model` 进注册表，选项在运行时动态获取，不是静态枚举。
- 因此**不存在多来源冲突**：面板保存的字段就是权威值，下次启动仍然生效，不会被 `opencode.json` 盖回去，也不需要「以面板为准」的接管标记。
- **环境变量彻底移除**，不再作为配置来源，也不保留兼容层；旧的环境变量名与旧选项别名（`RENAMED_ENV_VARS`、`RENAMED_OPTIONS`）以及改名提示一并删除，不识别、不告警。
- `XDG_DATA_HOME`、`XDG_STATE_HOME` 这类平台约定的目录基准仍然读取：它们决定文件落在哪，不属于配置项。
- **`chat-overrides.json` 与 `tool-profiles.json` 保持独立文件**：它们按聊天生效，粒度和生命周期与全局配置不同，不合并。它们的路径（`toolProfilesPath`、`chatOverridesPath`）是全局配置项，存放在 `config.json` 里。

### 工作目录

`workspace/config.json` 的位置由工作目录决定，而工作目录原来是个配置项——自举。现在工作目录固定：

- 工作目录固定为 `$XDG_DATA_HOME/opencode-qq-bot/workspace`（未设置时 `~/.local/share/opencode-qq-bot/workspace`），不再可配置，启动时自动创建。
- 配置文件位置随之固定为 `<工作目录>/config.json`，自举问题消失。
- 需要放到别处的文件用绝对路径指定（`toolProfilesPath`、`chatOverridesPath`、`soulPath` 都支持绝对路径）。

### 既有部署

不做任何向后兼容：`.env`、旧的环境变量名、旧选项别名一律不再支持，也不提供迁移工具与对照表。

- 现有部署写在 `opencode.json` 里的配置项（`agent` 除外）要搬进 `config.json`，按 `docs/configuration.md` 的字段表手写；字段表只描述新结构，不列旧名字。
- 启动时若 `config.json` 不存在，直接报错提示创建——不静默用默认值跑起来，否则机器人会表现为「突然不响应任何消息」，很难排查。
- `opencode.json` 里除 `agent` 以外的键一律忽略，不告警也不生效。
- 配置来源变化属于破坏性变更，需在 CHANGELOG 标注。

## 配置字段注册表

`src/config/fields.ts` 描述每一个配置项：

```ts
export interface ConfigField {
  /** 配置路径，例如 `rateLimit.maxPerMinute`。 */
  path: string
  /** 所属分组，用于表单导航。 */
  group: string
  /** 值的类型，决定前端渲染成哪种控件。 */
  type: FieldType
  /** 中文标签。 */
  label: string
  /** 补充说明。 */
  description?: string
  /** 默认值。 */
  default: unknown
  /** 数值下限。 */
  min?: number
  /** 数值上限。 */
  max?: number
  /** 数值步长。 */
  step?: number
  /** 枚举候选值。 */
  options?: readonly string[]
  /** 是否属于敏感字段：不回显、掩码显示。 */
  secret?: boolean
  /** 保存后是否可以立即生效，不必重启。 */
  hot?: boolean
}

export type FieldType =
  | "boolean"
  | "number"
  | "text"
  | "secret"
  | "enum"
  | "numberList"
  | "stringList"
  | "clock"
  | "modelRef"
  | "path"
```

由注册表生成以下产物，任何一处新增字段只需改注册表：

1. `DEFAULT_CONFIG`
2. zod 校验 schema（**逐字保持现有告警与回退语义**：`resolveConfig` 的行为不变）
3. 配置文件里允许出现的键集合（替代 `OPTION_KEYS` / `NESTED_OPTION_KEYS`；未知键保留原样并告警）
4. `GET /api/config/schema` 的 JSON Schema，附带 `x-label`、`x-ui` 等前端提示

一致性测试（扩展 `tests/config.test.ts`）：注册表、`DEFAULT_CONFIG`、文件键集合三方对齐，字段路径与类型双向覆盖。

`agent` 不在注册表里：它只从 `opencode.json` 读，面板在状态页只读展示，不提供编辑入口。

`model` 在注册表里，类型是 `modelRef`：值形如 `provider/model`，选项不是注册表里写死的枚举，而是运行时向 OpenCode 要——`ctx.model.list()` 返回可用模型（`opencode.json` 的 provider 配置 + 模型目录），`ctx.model.default()` 是当前默认模型。注册表只声明「这是个模型引用」，具体候选项由 `GET /api/models` 提供。留空表示跟随 OpenCode 的默认模型。

## 依赖选型

### 运行时依赖（进 npm 包）

| 用途        | 包                  | 版本    | 理由                                                                                                                           |
| ----------- | ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| HTTP 框架   | `hono`              | 4.13.18 | 路由、SSE、静态托管、Cookie、CSRF、安全响应头都是内置中间件，少写胶水代码；Web 标准的 Request/Response；Bun 与 Node 同一份代码 |
| Node 适配器 | `@hono/node-server` | 2.1.7   | 只包一层 `node:http`；Bun 兼容 `node:http`，插件在哪个运行时启动都走同一条路径                                                 |
| 原子写文件  | `write-file-atomic` | 8.0.0   | 临时文件 + fsync + rename + 权限一次搞定，不用自己实现原子写；ISC                                                              |
| 文件监听    | `chokidar`          | 6.0.0   | 监听 `config.json` 被外部修改，比 `node:fs.watch` 稳（去抖、跨平台、重命名事件）；MIT                                          |

内置中间件直接覆盖需求：`hono/serve-static`（托管 `web/dist`）、`hono/streaming` 的 `streamSSE`（状态推送）、`hono/cookie` 的 `setCookie`/`getCookie`（会话 Cookie）、`hono/secure-headers`、`hono/csrf`。

版本要求：`write-file-atomic` 8 要求 Node `^22.22.2 || ^24.15.0 || >=26`，`chokidar` 6 要求 Node `>= 22.22`。插件实际跑在 OpenCode 的 Bun 运行时上，`engines` 只影响直接用 Node 跑插件的场景。

排除的方案：

- `express` / `fastify` / `koa`：体积大、绑定 Node 事件模型，没有 Web 标准请求对象，路由/静态/SSE 都要自己拼。
- `elysia`：绑定 Bun 运行时，vitest 与 Node 侧测试跑不了。
- 直接手写 `node:http`：路由、静态托管、SSE、JSON 解析都得自己实现，几十行胶水代码容易漏掉安全细节。
- 自己实现原子写与文件监听：这两处最容易写出「看起来能用、实际会丢数据」的版本。

### 不重复造轮子

原则：能用现成的就不自己写；自己写的部分只保留「没有现成轮子」的部分。

| 需求                  | 选型                                        | 说明                                                           |
| --------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| HTTP / 静态 / SSE     | `hono` + `@hono/node-server`                | 内置中间件覆盖路由、`streamSSE`、`serve-static`、Cookie、CSRF  |
| 原子写配置            | `write-file-atomic`                         | 自带临时文件、fsync、rename、文件权限                          |
| 监听配置改动          | `chokidar`                                  | 面板能感知外部编辑，提示重新加载                               |
| 随机令牌              | `node:crypto` 的 `randomBytes`              | 平台原生，无须三方库                                           |
| 令牌比对              | `node:crypto` 的 `timingSafeEqual`          | 恒定时间比较，平台原生                                         |
| 配置校验              | `zod`（已在依赖里）                         | 后端权威判定，`z.toJSONSchema()` 出 JSON Schema                |
| 前端 JSON Schema 校验 | `ajv` 8.20.0（MIT）                         | 直接吃 `/api/config/schema` 的 JSON Schema，前端不复制校验规则 |
| UI 组件               | `shadcn-svelte` + `bits-ui`                 | 组件源码进仓库，样式走 Tailwind 变量主题                       |
| 图标                  | `lucide-svelte` 1.0.1（ISC）                | shadcn 生态标配，不手画 SVG                                    |
| 提示条                | `svelte-sonner` 1.2.3（MIT）                | shadcn 的 toast 组件基于它，不自己写通知条                     |
| 时间与数字格式化      | `Intl.DateTimeFormat` / `Intl.NumberFormat` | 平台原生，自带中文本地化，不引 moment/date-fns                 |

刻意用平台原生 API 的地方：`fetch`（数据请求）、`EventSource`（SSE，自带重连，只补连接状态显示）、`node:crypto`、`Intl`。这些是运行时自带能力，引入库反而多一层封装。

不引的库及原因：

- `@tanstack/svelte-query`：面板只有「读一次 + 轮询/SSE 刷新」，缓存层与失效策略用不上，反而多一套心智负担。
- `date-fns` / `moment`：`Intl` 已覆盖格式化与相对时间。
- `chart.js` / `layerchart`：用量条用 shadcn 的 `Progress` 组件即可，不引入图表库。
- 表单库（`superforms` 等）：面向 SvelteKit，本项目是纯 Vite SPA，schema 驱动的动态表单用 runes 直接写更短。

### 鉴权：单令牌 + Hono 内置中间件

面板是单用户本地工具，用单令牌模式就够，不需要 JWT 与会话框架：

- **令牌可手动配置**：`panel.token` 是普通配置项，在 `config.json` 里写死即可，手写的令牌原样生效。
- **未配置时自动生成**：`node:crypto` 的 `randomBytes(32)` 生成随机令牌，明文写回 `config.json`，之后重启不变，用户随时能翻出来用。启动日志只提示「令牌已生成，请查看 `config.json` 里的 `panel.token`」，不打印明文——日志会被外发，令牌不该跟着走。
- 存储：`config.json` 明文保存（文件 `0600`、目录 `0700`）。和 NapCat 令牌一样，明文只落在本机的受限文件里。
- 比对：内存里算 sha256，用 `crypto.timingSafeEqual` 比较等长哈希，恒定时间，不泄露长度以外的信息。
- 浏览器访问：`POST /api/login` 用令牌换取 `HttpOnly` + `SameSite=Strict` 的 Cookie，之后的请求自动带上。Cookie 的读写用 `hono/cookie` 的 `setCookie` / `getCookie`，不手拼 `Set-Cookie`。
- 弱令牌提示：手动配置的令牌短于 16 个字符时启动告警，但不阻断——用户有权决定自己的强度。

排除的方案：

- `jose` / `hono/jwt`：单用户面板不需要签发、过期、刷新、多密钥，反而多一份密钥管理。
- `hono-session`：2024 年后未再发布（1.2.0，月下载 560），维护状态与本项目要求不符；会话逻辑只有一个「令牌换 Cookie」，不值得引一个不活跃的依赖。
- `lucia` / `better-auth` / `next-auth`：面向多用户账号体系，用不上。
- HTTP Basic：不适合 SPA，且 `EventSource` 不能带自定义头。

**关键约束**：`EventSource` 不支持自定义请求头，SSE 无法用 `Authorization` 头鉴权，只能走 Cookie（或把令牌放进 query，但会进访问日志，不采用）。因此写接口必须带 CSRF 防护，用 `hono/csrf` 校验 Origin。

### 校验与 Schema

- `zod` 4.6.7（已在依赖里）：`z.toJSONSchema()` 内置生成 JSON Schema，不需要 `zod-to-json-schema`。
- 不引入 `@hono/zod-validator`：现有 `resolveConfig` 有「非法值回退默认值 + 告警」的语义，需要自己调用 schema 解析，中间件的 fail-fast 语义不合适。
- 前端用 `ajv` 8.20.0 直接校验 `/api/config/schema` 返回的 JSON Schema，规则只有一份，前端不另写一套 min/max/enum 判断。

### 前端

| 用途        | 包                             | 版本   |
| ----------- | ------------------------------ | ------ |
| 框架        | `svelte`                       | 5.57.3 |
| 构建        | `vite`                         | 8.3.8  |
| Svelte 插件 | `@sveltejs/vite-plugin-svelte` | 7.3.1  |
| 类型检查    | `svelte-check`                 | 4.7.8  |
| 组件测试    | `@testing-library/svelte`      | 5.4.2  |
| DOM 环境    | `happy-dom`                    | 21.0.4 |
| UI 生成器   | `shadcn-svelte`                | 1.8.0  |
| 样式        | `tailwindcss`                  | 4.3.5  |
| 样式构建    | `@tailwindcss/vite`            | 4.3.5  |
| 无样式原语  | `bits-ui`                      | 2.21.0 |
| Schema 校验 | `ajv`                          | 8.20.0 |
| 图标        | `lucide-svelte`                | 1.0.1  |
| 提示条      | `svelte-sonner`                | 1.2.3  |

- 数据层用平台原生 `fetch` + `EventSource`：`EventSource` 自带断线重连，只补「连接状态」显示；不引请求库，封装集中在 `web/src/lib/api.ts`。
- UI 用 `shadcn-svelte`：CLI 把组件源码复制进 `web/src/lib/components/ui/`，代码归仓库所有，不作为运行时依赖；底层是 `bits-ui`（无样式原语），样式走 Tailwind v4 + CSS 变量主题，明暗色内置。
- 需要的组件：`Button`、`Input`、`Textarea`、`Label`、`Field`、`Switch`、`Checkbox`、`RadioGroup`、`Select`、`Combobox`、`Slider`、`Card`、`Table`、`Tabs`、`Dialog`、`AlertDialog`、`Sheet`、`Popover`、`DropdownMenu`、`Alert`、`Badge`、`Skeleton`、`Spinner`、`Toast`、`Tooltip`、`ScrollArea`、`Pagination`、`Separator`、`Progress`、`Meter`、`Kbd`、`ToggleGroup`。用 `bunx shadcn-svelte@latest add <name>` 按需添加，缺失组件再补。
- 图标用 `lucide-svelte`，提示条用 `svelte-sonner`（shadcn 的 toast 组件基于它），不手画 SVG、不自己写通知条。
- 校验用 `ajv` 按服务端 JSON Schema 走，前端不另写一套规则。
- 依赖分层：Tailwind 与 CLI 只在构建期；前端运行时依赖为 `bits-ui`（MIT）、`ajv`（MIT）、`lucide-svelte`（ISC）、`svelte-sonner`（MIT）及 `bits-ui` 的 peer `@internationalized/date`（Apache-2.0，仅日期组件用得到）。`web/dist` 预计 150 KB（gzip）左右。
- 许可：CLI 与 Tailwind 是构建期工具，不进 npm 包；复制进 `web/src` 的组件源码属 MIT，保留原文件头版权声明；`bits-ui` 产物随包分发，`NOTICE` 补一行；`lucide-svelte` 是 ISC，需按 ISC 声明；若 bundle 带入 `@internationalized/date` 代码，再补一条 Apache-2.0。

### 版本与许可

- 运行时新增 `hono`、`@hono/node-server`（MIT）、`write-file-atomic`（ISC）、`chokidar`（MIT），`NOTICE` 各补一行。
- `svelte` 的编译产物随 `web/dist` 分发（Svelte 为 MIT），`NOTICE` 也要提一句。
- 前端新增 `bits-ui`（MIT）、`ajv`（MIT）、`svelte-sonner`（MIT）、`lucide-svelte`（ISC），产物随 `web/dist` 分发，`NOTICE` 各补一行；复制进仓库的 shadcn 组件源码保留原版权头。
- 包管理统一用 `bun`；`web/` 作为独立 `package.json`，根 `package.json` 增加 `web:dev` 与 `web:build` 脚本。

## HTTP 服务

`src/panel/server.ts`，用 Hono 实现，随插件 `cleanup` 启停；插件被 OpenCode 卸载时服务一并关闭。

面板自身的配置项也是注册表的一员：

| 配置项          | 默认值      | 说明                                         |
| --------------- | ----------- | -------------------------------------------- |
| `panel.enabled` | `false`     | 是否启用面板                                 |
| `panel.host`    | `127.0.0.1` | 监听地址                                     |
| `panel.port`    | `7391`      | 监听端口                                     |
| `panel.token`   | 空          | 访问令牌；可手动配置，未配置时自动生成并落盘 |

面板默认关闭：要用面板去配置其它项，得先在 `config.json` 里打开 `panel.enabled` 并写好令牌。令牌改动属于热更新，但会立刻作废已签发的会话 Cookie。

### API

| 方法 | 路径                 | 说明                                  |
| ---- | -------------------- | ------------------------------------- |
| POST | `/api/login`         | 用令牌换取会话 Cookie                 |
| GET  | `/api/config/schema` | 字段元数据与分组，前端据此渲染表单    |
| GET  | `/api/config`        | 生效值、文件值与每字段来源            |
| PUT  | `/api/config`        | 提交变更，后端用同一份 zod 校验后落盘 |
| GET  | `/api/models`        | 可用模型列表（`model` 字段的候选项）  |
| GET  | `/api/status`        | 运行状态快照                          |
| GET  | `/api/logs`          | 日志尾部（内存环形缓冲）              |
| GET  | `/api/stream`        | SSE：状态、配置变更与日志推送         |
| GET  | `/*`                 | Svelte 构建产物                       |

`GET /api/config` 每字段返回：

```jsonc
{
  "path": "rateLimit.maxPerMinute",
  "value": 8, // 生效值
  "fileValue": 8, // config.json 里的值
  "source": "file", // file | default
  "secret": false,
  "hot": true,
}
```

`source` 只有两种：`file` 表示文件里写了，`default` 表示走默认值。不存在「被别处覆盖」的情况。

`GET /api/models` 返回 OpenCode 当前可用的模型（`ctx.model.list()`），每项含 `providerID`、`id` 与展示名，另附 `ctx.model.default()` 作为默认标记。模型列表不来自 `config.json`，也不来自插件的注册表——它由 OpenCode 的 provider 配置与模型目录决定。

鉴权两条路：`Authorization: Bearer <token>` 供命令行与 `curl` 使用；浏览器先 `POST /api/login` 换会话 Cookie，之后自动带上。两者未授权都返回 401。敏感字段（`napcat.token`）只返回 `hasValue: true`，不返回明文。

## 状态面板

状态快照由 `collectStatus()` 统一采集，`/api/status` 与 SSE 共用同一份实现。

| 面板卡片   | 数据源                                    | 需要的改动                                 |
| ---------- | ----------------------------------------- | ------------------------------------------ |
| 连接概览   | `QQClient.connected`、`selfId`            | 记录重连次数与最后重连时间                 |
| 会话表     | `SessionManager.snapshot()`               | 合并 `ChatOverrides.for()` 的唤醒方式      |
| 限流用量   | `SendRateLimiter` 内部计数                | 新增 `snapshot()`，给出每目标分钟/小时用量 |
| 追踪时间线 | `Tracer.spans()`                          | 无                                         |
| 日记调度   | `DiaryScheduler`                          | 暴露下次总结时刻、下次轮询时间与上次结果   |
| 工具策略   | `ToolPolicy.current()`、`profileOf()`     | 无                                         |
| 日志尾部   | 日志器内存环形缓冲                        | 新增缓冲与读取接口                         |
| 运行时     | 版本、启动时间、home 与日志目录、实例租约 | 聚合 `RuntimeStatus`                       |

前端呈现：用量条用 shadcn 的 `Progress`，时间与数字用 `Intl` 格式化，图标用 `lucide-svelte`，不自己画图表与图标。

### 日志尾部

日志要能在面板里直接看，不必去翻日志文件。

- `src/logger.ts` 增加一个**进程内环形缓冲**：写入时把条目压进缓冲，容量 500 条，超出丢最旧的。条目结构为 `{ time, level, message, meta }`。
- 缓冲里的副本同样过一遍 `maskSecrets`：文件里打码了，面板里也必须打码，否则令牌会从面板漏出去。
- 新增 `readLogTail({ limit, level })`：返回最近若干条，可按级别过滤。面板 `GET /api/logs?limit=200&level=warn` 取历史，`/api/stream` 推 `log` 事件做增量。
- 缓冲只覆盖**当前进程**的日志，与 `winston-daily-rotate-file` 的落盘轮转互不影响；要看跨重启的历史仍然看日志文件。
- 面板的日志页：级别过滤、自动滚动到底、手动暂停（往回翻时暂停自动滚动）、按关键字过滤（前端做，不进后端）。

## 前端

技术选型：Svelte 5（runes）+ Vite + TypeScript + Tailwind v4。UI 用 `shadcn-svelte`：组件源码由 CLI 生成到 `web/src/lib/components/ui/`，样式走 Tailwind 变量主题，不手写控件。SSE 用 `EventSource`（自带重连），只补连接状态显示。

校验权威在后端 zod；前端用 `ajv` 按 `/api/config/schema` 返回的 JSON Schema 校验，规则只有一份，前端不复制校验逻辑。

### 类型到控件的映射

| `type`       | 控件                                          |
| ------------ | --------------------------------------------- |
| `boolean`    | 开关                                          |
| `number`     | 数字输入，带 `min`/`max`/`step`，越界就地提示 |
| `enum`       | 下拉选择                                      |
| `text`       | 文本输入                                      |
| `path`       | 文本输入 + 目录选择                           |
| `secret`     | 掩码输入 + 显示/隐藏，留空表示不修改          |
| `numberList` | 标签输入（QQ 号、群号）                       |
| `stringList` | 标签输入（前缀、目录列表）                    |
| `clock`      | 时间输入（`HH:mm`）                           |
| `modelRef`   | 下拉选择，候选项来自 `/api/models`，支持搜索  |

### 页面

- 顶栏：连接状态、版本、运行时长、「需重启生效」提示。
- Tab：配置 / 状态 / 日志 / 追踪。
- 配置页：左侧分组导航（`napcat`、`access`、`proactive`、`wake`、`reply`、`trace`、`reminder`、`keepAlive`、`history`、`rateLimit`、`sensitive`、`events`、`log`、`media`、`diary`、`panel`），右侧渲染当前分组的表单；每字段一行显示「当前值 / 来源（文件或默认）/ 说明」。
- 状态页：连接概览卡片、会话表、限流用量条、追踪时间线、日记卡片、当前 agent（只读，来自 `opencode.json`）。
- 日志页：级别过滤、关键字过滤、自动滚动与暂停。

表单由 `/api/config/schema` 驱动：注册表新增字段后，刷新页面即出现对应控件，前端不含任何硬编码字段名。

## 保存语义与热更新

保存流程：`PUT /api/config` → 校验补丁 → 合并进原始配置 → 解析成运行时配置（**解析不过就不碰文件**）→ 用 `write-file-atomic` 写入 `config.json` → 热字段就地生效 → 推送 SSE。

- 提交的是**稀疏补丁**：只包含用户改动的字段；把某字段清空表示从文件里删除该键，从而回到默认值。
- **必填字段不允许删除**：`napcat.url` 这类字段传 `null` 直接被拒（接口返回 400），文件保持原样。
- 生效分两类：
  - **可热更新**（注册表里 `hot: true`）：放行名单、拒绝名单、事件订阅、限流参数、回复分段与延迟、日志级别、面板自身设置。这些字段在运行时被读取，改完立即生效。
  - **需重启**：NapCat 地址与令牌、角色设定路径、保活间隔、日记路径与保留天数等启动期读取的字段。面板在保存后明确列出这些字段并提示重启。
- 保存即写进 `config.json`，是唯一的权威值，下次启动仍然生效，不存在被别处覆盖的情况。

保存失败要区分「校验不通过」与「写入失败」，两者都返回具体到字段的原因，不做笼统报错。

## 安全

- 默认关闭（`panel.enabled=false`），默认只监听 `127.0.0.1`。
- 必须有令牌：可手动配置，未配置时自动生成随机令牌并明文落盘到 `config.json`（`0600`），启动日志不打印明文。
- 令牌只写 `config.json`，**不回写 `opencode.json`**：`opencode.json` 归 OpenCode 管理，插件不写。
- 手动配置的令牌短于 16 个字符时输出告警，不阻断启动。
- 浏览器侧用 `HttpOnly` + `SameSite=Strict` 的会话 Cookie，写接口校验 Origin（`hono/csrf`）。
- `config.json` 权限 `0600`，目录 `0700`；NapCat 令牌以明文存放，这是取消环境变量后的必然结果，面板全程掩码、接口不回显。
- 静态资源带 CSP 响应头（`hono/secure-headers`）；写接口只接受 JSON 请求体。

## 影响面

配置来源收敛到 `config.json` 牵动的代码与文档：

| 位置                                         | 改动                                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config.ts`                              | 删除 `ENV_VARS`、`fromEnv`、`RENAMED_ENV_VARS`、`RENAMED_OPTIONS`、`envLabel`、`MIGRATION_WARNING_PREFIX`、`OPTION_KEYS`、`NESTED_OPTION_KEYS`，以及配置里的 `home`；`model` 保留但来源改为 `config.json`（默认值不再取 `QQ_BOT_MODEL`）；`resolveConfig` 改为只读 `config.json` 与默认值 |
| `src/index.ts`                               | 启动时读 `workspace/config.json`；不再传 `process.env`、不再上报改名提示；`agent` 仍从 `ctx.options` 读，其余插件选项忽略                                                                                                                                                                 |
| `src/home.ts`                                | 工作目录固定，不再可配置                                                                                                                                                                                                                                                                  |
| `.env.example`                               | 删除（环境变量不再是配置来源）                                                                                                                                                                                                                                                            |
| `README.md`、`docs/configuration.md`         | 配置表改为 `config.json` 的字段与取值规则；不列旧环境变量名与旧选项别名                                                                                                                                                                                                                   |
| `tests/config.test.ts`、`tests/docs.test.ts` | 改为校验字段注册表与配置文件文档；`docs.test.ts` 不再检查环境变量文档                                                                                                                                                                                                                     |
| `src/sensitive.ts`                           | 保留：环境变量仍参与日志脱敏，与配置来源无关                                                                                                                                                                                                                                              |
| `package.json`                               | 新增运行时依赖 `hono`、`@hono/node-server`、`write-file-atomic`、`chokidar`                                                                                                                                                                                                               |
| `NOTICE`                                     | 补齐新增依赖的许可声明（MIT/ISC）                                                                                                                                                                                                                                                         |

## 目录结构

```
src/config/fields.ts     字段注册表（单一事实源）
src/config/registry.ts   生成器：默认值 / zod / 文件键集合 / JSON Schema
src/config/store.ts      config.json 读写（write-file-atomic + chokidar）
src/panel/server.ts      HTTP 服务与静态托管
src/panel/api.ts         路由与鉴权
src/panel/status.ts      运行状态快照采集
src/panel/runtime.ts     运行时句柄聚合
src/panel/models.ts      可用模型列表（ctx.model.list()）
web/                     Svelte 单页应用（独立 package.json）
  components.json         shadcn-svelte 配置
  src/app.css             Tailwind 入口 + 主题变量
  src/lib/components/ui/  shadcn 生成的组件源码
  src/lib/fields.ts      类型到控件的映射
  src/lib/api.ts         fetch 与 SSE 封装
  src/routes/            配置页、状态页、日志页、追踪页
```

## 实施阶段

| 阶段 | 内容                                                                               | 验收                                                             |
| ---- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 0    | 抽出字段注册表，由它生成默认值、zod 与文件键集合                                   | 现有测试全绿；新增一致性测试                                     |
| 1    | 引入 `config.json` 层：文件读取与默认值回退；移除环境变量与插件选项来源            | 配置文件生效；`.env` 与 `opencode.json` 里的其余选项都不再被读取 |
| 2    | HTTP 服务、鉴权、`/api/config/schema`、`/api/config`、`/api/models`、`/api/status` | 未授权 401；`curl` 可读                                          |
| 3    | Svelte 骨架与自动表单（读取 + 本地编辑），组件用 `shadcn-svelte add` 引入          | 表单覆盖全部注册表字段，前端零硬编码字段名                       |
| 4    | 保存落盘、热更新与「需重启」提示                                                   | 重启后配置仍生效；热字段立即生效                                 |
| 5    | 状态面板、日志尾部与 SSE                                                           | 面板内容与 `/status` 命令输出一致；日志页能实时滚动              |
| 6    | 打包（`web/dist` 进 `files`）、更新 `docs/configuration.md` 与 README              | `npm pack` 含前端产物；文档字段表与注册表一致                    |

## 风险

- **阶段 0 触及配置解析核心**：必须保持现有告警与回退语义，用 `tests/config.test.ts` 兜底。
- **配置来源收敛是破坏性变更，且明确不提供兼容层与迁移工具**：现有部署必须把 `opencode.json` 里的配置项搬进 `config.json` 才能继续工作。缓解措施只有启动报错：检测到 `config.json` 不存在时明确提示创建，而不是静默用默认值启动。
- **插件选项整体退出配置体系**：除 `agent` 外，`opencode.json` 里的键全部失效且不告警。用户容易以为「改了没反应」，README 与 CHANGELOG 要写清楚。
- **`model` 的候选项不在配置里**：可用模型由 OpenCode 的 provider 配置与模型目录决定，面板只是借 `ctx.model.list()` 转述；OpenCode 侧改了 provider 配置而插件未重载时，候选列表可能滞后，需要在面板提示「模型列表来自 OpenCode，可能需要重载」。
- **插件内嵌 HTTP 服务**：需确认 OpenCode 卸载插件时服务随 `cleanup` 一并关闭，不留残留端口。
- **前端产物进包**：构建产物约 150–200 KB（gzip），可接受。
- **shadcn 组件源码进仓库**：组件由 CLI 生成到 `web/src/lib/components/ui/`，升级要重新生成，人工改动会被覆盖；改组件前先确认是不是应该改 shadcn 源码而不是直接改生成文件。
- **文件监听去抖**：`chokidar` 对编辑器「保存」这类动作可能连发多次事件，需要去抖后再推 SSE，否则面板会闪。
- **日志环形缓冲只覆盖当前进程**：重启后面板看不到上次的日志，跨重启的历史仍需查日志文件。

## 待定决策

无。已全部拍板：

- 工作目录固定为 `$XDG_DATA_HOME/opencode-qq-bot/workspace` 且不可配置。
- `agent` 留在 `opencode.json`（OpenCode 侧路由语义），`model` 作为偏好写进 `config.json`（可用模型列表来自 OpenCode）。

## 落地说明

阶段 0~6 已按本设计稿实现，没有引入额外的配置来源或兼容层。

### 后端

- 字段注册表：`src/config/fields.ts` 定义全部字段、分组、类型、默认值、约束与 `hot`；
  `src/config/registry.ts` 由它生成 `DEFAULT_CONFIG`、zod schema、文件键集合与 JSON Schema，
  `src/config.ts` 只负责把文件内容解析成运行时对象。
- 配置文件：`src/config/store.ts` 负责原子写（`write-file-atomic`，保留 `.bak`）、
  目录 `0700`、文件 `0600`；文件不存在抛 `ConfigMissingError`，JSON 非法抛 `ConfigParseError`。
  监听走 `chokidar`，外部改动解析成功后热更新。
- 热更新：`src/config/live.ts` 的 `applyPatch` 只改叶子值并保持中间对象引用，
  `restartRequired` 由注册表的 `hot` 决定；面板保存与文件监听共用同一条解析路径。
- HTTP：`src/panel/server.ts` 用 `@hono/node-server` 的 `createAdaptorServer` 启动，
  `src/panel/auth.ts` 管理令牌与会话，`src/panel/api.ts` 提供接口。令牌比较用定长摘要比较；
  未配置时随机生成、明文写回 `config.json`，启动日志不打印明文（令牌按已知密钥掩码）。
- 状态：`src/panel/status.ts` 汇总连接、会话、限流、追踪、日记与工具策略；
  `/api/status` 与 SSE `status` 事件共用这一份快照。
- 日志：`src/logger.ts` 维护 500 条环形缓冲与脱敏副本，`/api/logs` 与 SSE `log` 事件读取同一份数据；
  `setLogLevel` 让 `log.level` 保存后立即生效，`Logger` 的四个方法签名保持不变。

### 接口

| 方法   | 路径                 | 说明                                                               |
| ------ | -------------------- | ------------------------------------------------------------------ |
| `POST` | `/api/login`         | 用令牌换会话 Cookie（`qqbot_session`，HttpOnly + SameSite=Strict） |
| `GET`  | `/api/config/schema` | 分组、字段元数据与 JSON Schema                                     |
| `GET`  | `/api/config`        | 每字段生效值、文件值与来源                                         |
| `PUT`  | `/api/config`        | 提交稀疏补丁；只收 JSON，校验失败返回 `fields[].path`              |
| `GET`  | `/api/models`        | OpenCode 可用模型与默认模型标记                                    |
| `GET`  | `/api/status`        | 运行状态快照                                                       |
| `GET`  | `/api/logs`          | 环形缓冲尾部，支持 `limit` 与 `level`                              |
| `GET`  | `/api/stream`        | SSE：`status` / `log` / `config`                                   |

鉴权支持 `Authorization: Bearer <token>` 与会话 Cookie 两条路；写接口校验 `Origin`，
并用 `hono/csrf` 兜底表单类请求；响应带 CSP 等安全头，静态资源由同一个服务托管。

### 前端

- `web/` 是独立的 Svelte 5 + Vite + Tailwind v4 工程，shadcn-svelte 组件源码在
  `web/src/lib/components/ui/`；构建产物 `web/dist` 随 npm 包发布（`files` 已包含）。
- 数据层只用原生 `fetch` 与 `EventSource`（`web/src/lib/api.ts`），不引入请求库。
- 表单由 `/api/config/schema` 驱动：字段名、分组、控件类型、枚举候选、数值范围与
  敏感字段全部来自注册表，前端不写死字段名；`ajv` 用同一份 JSON Schema 做提交前校验。
- 页面：配置（分组表单、搜索、待保存标记、需重启提示）、状态（连接、会话、限流、日记、策略）、
  日志（环形缓冲、级别过滤、搜索、暂停与自动滚动）、追踪（最近节点与属性）。

### 安全与运维

- 面板默认关闭；启用后默认只监听 `127.0.0.1:7391`。监听地址改成非本机前请确认网络边界。
- 敏感字段（如 `napcat.token`、`panel.token`）不回显，只返回 `hasValue`；留空表示不修改。
- 卸载插件时 `cleanup` 会关闭 HTTP 服务、SSE 连接与文件监听，不留残留端口。
- 日志与状态都来自当前进程：重启前的日志仍需查日志文件，跨重启的历史不在面板范围内。

### 验证

- `bun run typecheck`、`bun run lint`、`bun run test`、`bun run web:build` 均可通过。
- `tests/` 覆盖注册表一致性、配置文件读写与原子写、热更新与重启字段划分、鉴权与 CSRF、
  各接口、状态快照、日志环形缓冲与脱敏。
