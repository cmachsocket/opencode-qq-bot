<script lang="ts">
  import { onMount } from "svelte"
  import { Activity, LogOut, RefreshCw } from "lucide-svelte"
  import { api, ApiError, openStream } from "$lib/api"
  import { Badge } from "$lib/components/ui/badge"
  import { Button } from "$lib/components/ui/button"
  import { Input } from "$lib/components/ui/input"
  import { Label } from "$lib/components/ui/label"
  import { Separator } from "$lib/components/ui/separator"
  import * as Tabs from "$lib/components/ui/tabs"
  import ConfigPage from "./routes/ConfigPage.svelte"
  import LogsPage from "./routes/LogsPage.svelte"
  import StatusPage from "./routes/StatusPage.svelte"
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
  let restarting = $state(false)

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
    restarting = true
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
        {#if restarting}
          <Badge variant="outline">有字段需要重启生效</Badge>
        {/if}
        <Button variant="ghost" size="sm" onclick={() => void refresh()}>
          <RefreshCw class="size-4" />
          刷新
        </Button>
      </div>
    {/if}
  </header>

  <Separator />

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
        <Tabs.Trigger value="status">状态</Tabs.Trigger>
        <Tabs.Trigger value="logs">日志</Tabs.Trigger>
        <Tabs.Trigger value="trace">追踪</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="config">
        <ConfigPage {config} onrestart={onRestartNeeded} />
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
