<script lang="ts">
  import { Badge } from "$lib/components/ui/badge"
  import * as Card from "$lib/components/ui/card"
  import { Progress } from "$lib/components/ui/progress"
  import * as Table from "$lib/components/ui/table"
  import {
    formatClock,
    formatDate,
    formatDuration,
    formatNumber,
    formatRemaining,
  } from "$lib/format"
  import type { Status } from "$lib/types"

  interface Props {
    /** 运行状态快照；SSE 每两秒推一次。 */
    status?: Status
  }

  let { status }: Props = $props()

  /** 限流用量的百分比。 */
  function percent(used: number, max: number): number {
    if (max <= 0) return 0
    return Math.min(100, Math.round((used / max) * 100))
  }
</script>

{#if !status}
  <p class="text-muted-foreground p-4 text-sm">正在读取运行状态…</p>
{:else}
  <div class="grid gap-4 lg:grid-cols-2">
    <Card.Root>
      <Card.Header>
        <Card.Title>连接</Card.Title>
        <Card.Description>NapCat / NapLink WebSocket</Card.Description>
      </Card.Header>
      <Card.Content class="space-y-2 text-sm">
        <div class="flex items-center gap-2">
          <span class="text-muted-foreground w-24">状态</span>
          <Badge variant={status.connection.connected ? "default" : "destructive"}>
            {status.connection.connected ? "已连接" : "未连接"}
          </Badge>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-muted-foreground w-24">机器人</span>
          <span class="font-mono">{status.connection.selfId ?? "-"}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-muted-foreground w-24">重连次数</span>
          <span>{formatNumber(status.connection.reconnects)}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-muted-foreground w-24">上次重连</span>
          <span>{formatDate(status.connection.lastReconnectAt)}</span>
        </div>
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>运行时</Card.Title>
        <Card.Description>工作目录、模型与面板</Card.Description>
      </Card.Header>
      <Card.Content class="space-y-2 text-sm">
        <div class="flex gap-2">
          <span class="text-muted-foreground w-24 shrink-0">版本</span>
          <span>v{status.version}</span>
        </div>
        <div class="flex gap-2">
          <span class="text-muted-foreground w-24 shrink-0">已运行</span>
          <span>{formatDuration(status.uptimeMs)}</span>
        </div>
        <div class="flex gap-2">
          <span class="text-muted-foreground w-24 shrink-0">工作目录</span>
          <span class="font-mono break-all">{status.runtime.home}</span>
        </div>
        <div class="flex gap-2">
          <span class="text-muted-foreground w-24 shrink-0">日志目录</span>
          <span class="font-mono break-all">{status.runtime.logDir}</span>
        </div>
        <div class="flex gap-2">
          <span class="text-muted-foreground w-24 shrink-0">agent</span>
          <span class="font-mono">{status.runtime.agent ?? "-"}</span>
        </div>
        <div class="flex gap-2">
          <span class="text-muted-foreground w-24 shrink-0">模型</span>
          <span class="font-mono">{status.runtime.model ?? "跟随默认"}</span>
        </div>
        <div class="flex gap-2">
          <span class="text-muted-foreground w-24 shrink-0">面板</span>
          <span class="font-mono">
            {status.runtime.panel.enabled ? "已启用" : "已关闭"}
            · {status.runtime.panel.host}:{status.runtime.panel.port}
          </span>
        </div>
      </Card.Content>
    </Card.Root>

    <Card.Root class="lg:col-span-2">
      <Card.Header>
        <Card.Title>会话</Card.Title>
        <Card.Description>每个聊天目标的上游会话与消息缓存</Card.Description>
      </Card.Header>
      <Card.Content>
        {#if status.sessions.length === 0}
          <p class="text-muted-foreground text-sm">还没有任何会话。</p>
        {:else}
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>目标</Table.Head>
                <Table.Head>会话</Table.Head>
                <Table.Head>状态</Table.Head>
                <Table.Head>缓存</Table.Head>
                <Table.Head>唤醒</Table.Head>
                <Table.Head>主动</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each status.sessions as session (session.target)}
                <Table.Row>
                  <Table.Cell class="font-mono">{session.target}</Table.Cell>
                  <Table.Cell class="font-mono text-xs">{session.sessionID ?? "-"}</Table.Cell>
                  <Table.Cell>
                    {#if session.busy}
                      <Badge>处理中</Badge>
                    {:else if session.pending}
                      <Badge variant="secondary">等待重试</Badge>
                    {:else}
                      <Badge variant="outline">空闲</Badge>
                    {/if}
                  </Table.Cell>
                  <Table.Cell>{formatNumber(session.buffered)}</Table.Cell>
                  <Table.Cell>{session.wake ?? "默认"}</Table.Cell>
                  <Table.Cell>{session.proactive === undefined ? "默认" : session.proactive ? "开" : "关"}</Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>出站限流</Card.Title>
        <Card.Description>按聊天目标统计的分钟与小时用量</Card.Description>
      </Card.Header>
      <Card.Content class="space-y-3">
        {#if status.rateLimit.length === 0}
          <p class="text-muted-foreground text-sm">限流模块未启用或还没有记录。</p>
        {:else}
          {#each status.rateLimit as item (item.scope)}
            <div class="space-y-1">
              <div class="flex items-center justify-between text-xs">
                <span class="font-mono">{item.scope}</span>
                <span class="text-muted-foreground">
                  {formatNumber(item.usedPerMinute)}/{formatRemaining(item.maxPerMinute)} 每分钟 ·
                  {formatNumber(item.usedPerHour)}/{formatRemaining(item.maxPerHour)} 每小时
                </span>
              </div>
              <Progress value={percent(item.usedPerMinute, item.maxPerMinute)} />
              <div class="text-muted-foreground flex justify-between text-[11px]">
                <span>分钟剩余 {formatRemaining(item.minuteLeft)}</span>
                <span>小时剩余 {formatRemaining(item.hourLeft)}</span>
              </div>
            </div>
          {/each}
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>日记调度</Card.Title>
        <Card.Description>每日总结的生成时间与结果</Card.Description>
      </Card.Header>
      <Card.Content class="space-y-2 text-sm">
        <div class="flex gap-2">
          <span class="text-muted-foreground w-24">状态</span>
          <Badge variant={status.diary.enabled ? "default" : "outline"}>
            {status.diary.enabled ? "已启用" : "已关闭"}
          </Badge>
        </div>
        <div class="flex gap-2">
          <span class="text-muted-foreground w-24">总结时间</span>
          <span class="font-mono">{status.diary.summaryTime}</span>
        </div>
        <div class="flex gap-2">
          <span class="text-muted-foreground w-24">下次总结</span>
          <span>{formatDate(status.diary.nextSummaryAt)}</span>
        </div>
        <div class="flex gap-2">
          <span class="text-muted-foreground w-24">下次轮询</span>
          <span>{formatDate(status.diary.nextRunAt)}</span>
        </div>
        <div class="flex gap-2">
          <span class="text-muted-foreground w-24">上次轮询</span>
          <span>{formatDate(status.diary.lastRunAt)}</span>
        </div>
        <div class="flex gap-2">
          <span class="text-muted-foreground w-24">上次结果</span>
          <span>{status.diary.lastResult ?? "-"}</span>
        </div>
      </Card.Content>
    </Card.Root>

    <Card.Root class="lg:col-span-2">
      <Card.Header>
        <Card.Title>工具策略</Card.Title>
        <Card.Description>默认配置档与按聊天的覆盖</Card.Description>
      </Card.Header>
      <Card.Content class="space-y-3 text-sm">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-muted-foreground">默认配置档</span>
          <Badge variant="secondary">{status.policy.defaultProfile}</Badge>
          <span class="text-muted-foreground ml-4">可用配置档</span>
          {#each status.policy.profiles as profile (profile)}
            <Badge variant="outline">{profile}</Badge>
          {:else}
            <span class="text-muted-foreground">-</span>
          {/each}
        </div>
        {#if Object.keys(status.policy.chats).length > 0}
          <div class="grid gap-1 sm:grid-cols-2">
            {#each Object.entries(status.policy.chats) as [target, profile] (target)}
              <div class="flex items-center justify-between rounded border px-2 py-1">
                <span class="font-mono text-xs">{target}</span>
                <Badge variant="outline">{profile}</Badge>
              </div>
            {/each}
          </div>
        {:else}
          <p class="text-muted-foreground text-xs">没有按聊天的策略覆盖。</p>
        {/if}
      </Card.Content>
    </Card.Root>
  </div>

  <p class="text-muted-foreground mt-2 text-xs">
    启动于 {formatClock(status.startedAt)} · 快照时间 {formatClock(Date.now())}
  </p>
{/if}
