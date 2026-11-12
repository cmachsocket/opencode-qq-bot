<script lang="ts">
  import { Badge } from "$lib/components/ui/badge"
  import * as Card from "$lib/components/ui/card"
  import * as Table from "$lib/components/ui/table"
  import { formatClock, formatJson } from "$lib/format"
  import type { Status, TraceSpan } from "$lib/types"

  interface Props {
    /** 运行状态里带的最近追踪节点。 */
    status?: Status
  }

  let { status }: Props = $props()

  /** 最近的节点排在前面。 */
  let spans = $derived<TraceSpan[]>([...(status?.traces ?? [])].reverse())
</script>

{#if !status}
  <p class="text-muted-foreground p-4 text-sm">正在读取追踪数据…</p>
{:else}
  <Card.Root>
    <Card.Header>
      <Card.Title>调用追踪</Card.Title>
      <Card.Description>
        最近 {spans.length} 个节点；完整调用链在 trace 目录里，这里只展示运行中的摘要。
      </Card.Description>
    </Card.Header>
    <Card.Content>
      {#if spans.length === 0}
        <p class="text-muted-foreground text-sm">还没有追踪节点。</p>
      {:else}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>时间</Table.Head>
              <Table.Head>节点</Table.Head>
              <Table.Head>目标</Table.Head>
              <Table.Head>trace</Table.Head>
              <Table.Head>属性</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each spans as span (span.spanId)}
              <Table.Row>
                <Table.Cell class="whitespace-nowrap font-mono text-xs">
                  {formatClock(span.at)}
                </Table.Cell>
                <Table.Cell>
                  <Badge variant="outline">{span.name}</Badge>
                </Table.Cell>
                <Table.Cell class="font-mono text-xs">{span.target ?? "-"}</Table.Cell>
                <Table.Cell class="font-mono text-xs">{span.traceId.slice(0, 8)}</Table.Cell>
                <Table.Cell class="max-w-72">
                  {#if span.attributes && Object.keys(span.attributes).length > 0}
                    <details>
                      <summary class="text-muted-foreground cursor-pointer text-xs">
                        {Object.keys(span.attributes).length} 项
                      </summary>
                      <pre class="bg-muted mt-1 overflow-auto rounded p-2 text-[11px]"
                        >{formatJson(span.attributes)}</pre
                      >
                    </details>
                  {:else}
                    <span class="text-muted-foreground text-xs">-</span>
                  {/if}
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {/if}
    </Card.Content>
  </Card.Root>
{/if}
