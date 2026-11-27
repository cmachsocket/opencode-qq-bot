<script lang="ts">
  import { onMount } from "svelte"
  import { Activity, LogOut, RefreshCw, RotateCw } from "lucide-svelte"
  import { api, ApiError, openStream } from "$lib/api"
  import { Badge } from "$lib/components/ui/badge"
  import { Button } from "$lib/components/ui/button"
  import { Input } from "$lib/components/ui/input"
  import { Label } from "$lib/components/ui/label"
  import { Separator } from "$lib/components/ui/separator"
  import * as Tabs from "$lib/components/ui/tabs"
  import ChatOverridesPage from "./routes/ChatOverridesPage.svelte"
  import ConfigPage from "./routes/ConfigPage.svelte"
  import LogsPage from "./routes/LogsPage.svelte"
  import StatusPage from "./routes/StatusPage.svelte"
  import ToolProfilesPage from "./routes/ToolProfilesPage.svelte"
  import TracePage from "./routes/TracePage.svelte"
  import type { ConfigResponse, LogEntry, Status } from "$lib/types"

  let token = $state("")
  let authenticated = $state(false)
  let error = $state("")
  let busy = $state(false)
  let tab = $state("config")
  let status = $state<Status | undefined>(undefined)
  let logs = $state<LogEntry[]>([])
  let config = $state<ConfigResponse | undefined>(undefined)
  let stopStream: (() => void) | undefined
  /** 有冷配置变更，提示需要重启。 */
  let needsRestart = $state(false)
  /** 正在执行面板触发的重启。 */
  let restartBusy = $state(false)
  /** 登录成功的令牌，用于重启后自动重新登录。 */
  let sessionToken = $state("")

  /** 时间与数字的格式化：平台原生，自带中文本地化。 */
  const time = new Intl.DateTimeFormat("zh-CN", { timeStyle: "medium" })
  const number = new Intl.NumberFormat("zh-CN")

  onMount(() => {
    void refresh()
    return () => stopStream?.()
  })

  /** 读取状态：没登录就是 401，这时显示登录框。 */
  async function refresh(): Promise<void> {
    try {
      status = await api.status()
      authenticated = true
      error = ""
      connect()
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        authenticated = false
        return
      }
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  /** 订阅 SSE：状态、配置与日志推送。 */
  function connect(): void {
    stopStream?.()
    stopStream = openStream({
      status: (next) => {
        status = next
      },
      log: (entry) => {
        logs = [...logs, entry].slice(-500)
      },
      config: (next) => {
        config = next
      },
    })
  }

  /** 用令牌换会话 Cookie。 */
  async function login(): Promise<void> {
    busy = true
    error = ""
    try {
      await api.login(token)
      sessionToken = token
      token = ""
      await refresh()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy = false
    }
  }

  /** 保存后如果提示要重启，这里把重启按钮点亮。 */
  function onRestartNeeded(): void {
    needsRestart = true
  }

  /** 面板触发就地重启：等插件重新初始化完成后刷新状态。 */
  async function restartPlugin(): Promise<void> {
    if (restartBusy) return
    restartBusy = true
    error = ""
    // 服务马上会断开，先停掉 SSE，避免自动重连刷错误。
    stopStream?.()
    stopStream = undefined
    try {
      await api.restart()
      const ready = await waitForRestart()
      if (!ready) return
      needsRestart = false
    } catch (cause) {
      error =
        cause instanceof ApiError && cause.status === 501
          ? "当前运行时不支持重启，请手动重启。"
          : cause instanceof Error
            ? cause.message
            : String(cause)
    } finally {
      restartBusy = false
    }
  }

  /** 轮询状态直到插件重新就绪；返回是否成功连回。 */
  async function waitForRestart(): Promise<boolean> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      try {
        status = await api.status()
        authenticated = true
        // 新进程的日志缓冲是空的，别把上一代的日志留在页面上。
        logs = []
        connect()
        return true
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401) {
          // 令牌没变的话会话通常会带过来；没带过来就用内存里的令牌重登。
          if (sessionToken && (await relogin())) continue
          authenticated = false
          error = "插件已重启，请重新登录。"
          return false
        }
        // 端口还没开始监听，继续等。
      }
    }
    error = "重启超时，请手动刷新页面。"
    return false
  }

  /** 重启后会话失效时，用登录时记下的令牌重新换 Cookie。 */
  async function relogin(): Promise<boolean> {
    try {
      await api.login(sessionToken)
      return true
    } catch {
      sessionToken = ""
      return false
    }
  }
</script>

<div class="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 p-4">
  <header class="flex flex-wrap items-center gap-3">
    <h1 class="text-lg font-semibold">opencode-qq-bot 面板</h1>
    {#if status}
      <Badge variant={status.connection.connected ? "default" : "destructive"}>
        {status.connection.connected ? "已连接" : "未连接"}
      </Badge>
      <span class="text-muted-foreground text-sm">
        v{status.version} · 运行 {Math.floor(status.uptimeMs / 1000)} 秒
      </span>
      <div class="ml-auto flex items-center gap-2">
        {#if needsRestart}
          <Badge variant="outline">有字段需要重启生效</Badge>
        {/if}
        <Button
          variant={needsRestart ? "default" : "outline"}
          size="sm"
          disabled={restartBusy}
          onclick={() => void restartPlugin()}
        >
          <RotateCw class={restartBusy ? "size-4 animate-spin" : "size-4"} />
          {restartBusy ? "正在重启…" : "重启插件"}
        </Button>
        <Button variant="ghost" size="sm" disabled={restartBusy} onclick={() => void refresh()}>
          <RefreshCw class="size-4" />
          刷新
        </Button>
      </div>
    {/if}
  </header>

  <Separator />

  {#if authenticated && error}
    <p class="text-destructive text-sm">{error}</p>
  {/if}

  {#if !authenticated}
    <div class="mx-auto mt-16 w-full max-w-sm space-y-3">
      <h2 class="text-base font-medium">需要访问令牌</h2>
      <p class="text-muted-foreground text-sm">
        令牌在 <code>config.json</code> 的 <code>panel.token</code> 里；没有配置时插件启动会生成一个并写回文件。
      </p>
      <Label for="token">令牌</Label>
      <Input
        id="token"
        type="password"
        bind:value={token}
        placeholder="面板访问令牌"
        onkeydown={(event) => {
          if (event.key === "Enter") void login()
        }}
      />
      {#if error}
        <p class="text-destructive text-sm">{error}</p>
      {/if}
      <Button class="w-full" disabled={busy || !token} onclick={() => void login()}>
        <LogOut class="size-4" />
        登录
      </Button>
    </div>
  {:else}
    <Tabs.Root bind:value={tab} class="flex-1">
      <Tabs.List>
        <Tabs.Trigger value="config">配置</Tabs.Trigger>
        <Tabs.Trigger value="chat-overrides">会话覆盖</Tabs.Trigger>
        <Tabs.Trigger value="tool-profiles">工具档案</Tabs.Trigger>
        <Tabs.Trigger value="status">状态</Tabs.Trigger>
        <Tabs.Trigger value="logs">日志</Tabs.Trigger>
        <Tabs.Trigger value="trace">追踪</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="config">
        <ConfigPage {config} onrestart={onRestartNeeded} />
      </Tabs.Content>
      <Tabs.Content value="chat-overrides">
        <ChatOverridesPage onrestart={onRestartNeeded} />
      </Tabs.Content>
      <Tabs.Content value="tool-profiles">
        <ToolProfilesPage onrestart={onRestartNeeded} />
      </Tabs.Content>
      <Tabs.Content value="status">
        <StatusPage {status} />
      </Tabs.Content>
      <Tabs.Content value="logs">
        <LogsPage {logs} />
      </Tabs.Content>
      <Tabs.Content value="trace">
        <TracePage {status} />
      </Tabs.Content>
    </Tabs.Root>
  {/if}

  <footer class="text-muted-foreground mt-auto flex items-center gap-2 pt-4 text-xs">
    <Activity class="size-3" />
    <span>工作目录 {status?.runtime.home ?? "-"}</span>
    <span>·</span>
    <span>日志 {status?.runtime.logDir ?? "-"}</span>
    {#if status?.runtime.agent}
      <span>·</span>
      <span>agent {status.runtime.agent}</span>
    {/if}
    <span>·</span>
    <span>{number.format(status?.sessions.length ?? 0)} 个会话</span>
  </footer>
</div>
