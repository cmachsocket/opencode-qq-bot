<script lang="ts">
  import { onMount } from "svelte"
  import { Eraser, Pause, Play, RefreshCw, Search } from "lucide-svelte"
  import { api } from "$lib/api"
  import { Badge } from "$lib/components/ui/badge"
  import { Button } from "$lib/components/ui/button"
  import { Input } from "$lib/components/ui/input"
  import { formatClock, formatJson } from "$lib/format"
  import type { LogEntry } from "$lib/types"

  interface Props {
    /** SSE 推送的新日志。 */
    logs?: LogEntry[]
  }

  let { logs = [] }: Props = $props()

  const LEVELS = ["debug", "info", "warn", "error"] as const
  const MAX_ENTRIES = 2000

  let entries = $state<LogEntry[]>([])
  let level = $state("all")
  let search = $state("")
  let autoScroll = $state(true)
  let paused = $state(false)
  let loading = $state(false)
  let error = $state("")
  let container: HTMLElement | undefined
  let seen = new Set<string>()

  /** 日志的唯一键：时间 + 级别 + 正文。 */
  function keyOf(entry: LogEntry): string {
    return `${entry.time}|${entry.level}|${entry.message}`
  }

  /** 合并新日志并去重。 */
  function merge(incoming: LogEntry[]): void {
    const next = [...entries]
    for (const entry of incoming) {
      const key = keyOf(entry)
      if (seen.has(key)) continue
      seen.add(key)
      next.push(entry)
    }
    if (next.length > MAX_ENTRIES) {
      const dropped = next.splice(0, next.length - MAX_ENTRIES)
      for (const entry of dropped) seen.delete(keyOf(entry))
    }
    entries = next
  }

  /** 拉一次日志尾部。 */
  async function reload(): Promise<void> {
    loading = true
    error = ""
    try {
      const response = await api.logs({ limit: 500 })
      seen = new Set()
      entries = []
      merge(response.entries)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void reload()
  })

  // 暂停时仍然保留新日志，只是不追加到列表。
  $effect(() => {
    const incoming = logs
    if (incoming.length === 0 || paused) return
    merge(incoming)
  })

  // 有新内容时贴到底部。
  $effect(() => {
    entries.length
    if (autoScroll && container) container.scrollTop = container.scrollHeight
  })

  /** 过滤后的日志。 */
  let filtered = $derived(
    entries.filter((entry) => {
      if (level !== "all" && entry.level !== level) return false
      const text = search.trim()
      if (!text) return true
      return entry.message.includes(text) || formatJson(entry.meta).includes(text)
    }),
  )

  /** 清空当前列表。 */
  function clear(): void {
    entries = []
    seen = new Set()
  }

  /** 级别的展示色。 */
  function levelClass(value: string): string {
    switch (value) {
      case "error":
        return "text-destructive"
      case "warn":
        return "text-amber-600"
      case "debug":
        return "text-muted-foreground"
      default:
        return "text-sky-600"
    }
  }
</script>

<div class="flex flex-col gap-3">
  <div class="flex flex-wrap items-center gap-2">
    <select
      class="border-input bg-transparent h-9 rounded-md border px-2 text-sm shadow-xs"
      bind:value={level}
    >
      <option value="all">全部级别</option>
      {#each LEVELS as item (item)}
        <option value={item}>{item}</option>
      {/each}
    </select>
    <div class="relative">
      <Search class="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
      <Input class="w-56 pl-8" bind:value={search} placeholder="搜索日志内容" />
    </div>
    <span class="text-muted-foreground text-sm">
      {filtered.length} / {entries.length} 条
    </span>
    <div class="ml-auto flex items-center gap-2">
      <Button variant="ghost" size="sm" onclick={() => (paused = !paused)}>
        {#if paused}
          <Play class="size-4" />
          继续
        {:else}
          <Pause class="size-4" />
          暂停
        {/if}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onclick={() => (autoScroll = !autoScroll)}
        aria-pressed={autoScroll}
      >
        {autoScroll ? "自动滚动：开" : "自动滚动：关"}
      </Button>
      <Button variant="ghost" size="sm" onclick={clear}>
        <Eraser class="size-4" />
        清空
      </Button>
      <Button variant="ghost" size="sm" disabled={loading} onclick={() => void reload()}>
        <RefreshCw class="size-4" />
        重新读取
      </Button>
    </div>
  </div>

  {#if error}
    <p class="text-destructive text-sm">{error}</p>
  {/if}

  <div
    class="bg-muted/40 h-[65vh] overflow-auto rounded-lg border p-2 font-mono text-xs"
    bind:this={container}
  >
    {#each filtered as entry, index (keyOf(entry) + index)}
      <div class="hover:bg-muted flex gap-2 rounded px-1 py-0.5">
        <span class="text-muted-foreground shrink-0">{formatClock(Date.parse(entry.time))}</span>
        <span class="{levelClass(entry.level)} w-10 shrink-0 uppercase">
          {entry.level}
        </span>
        <span class="break-all whitespace-pre-wrap">{entry.message}</span>
        {#if entry.meta.length > 0}
          <span class="text-muted-foreground break-all">{formatJson(entry.meta)}</span>
        {/if}
      </div>
    {:else}
      <p class="text-muted-foreground p-4 text-sm">没有日志。</p>
    {/each}
  </div>

  <div class="text-muted-foreground flex items-center gap-2 text-xs">
    <Badge variant="outline">环形缓冲</Badge>
    <span>面板只保留最近 {MAX_ENTRIES} 条；完整日志在日志目录里。</span>
  </div>
</div>
