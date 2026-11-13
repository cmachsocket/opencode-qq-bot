<script lang="ts">
  import { X } from "lucide-svelte"
  import { Badge } from "$lib/components/ui/badge"
  import { Input } from "$lib/components/ui/input"

  interface Props {
    /** 标签列表。 */
    value: string[]
    /** 提示文字。 */
    placeholder?: string
    /** 数字标签：只允许正整数。 */
    numeric?: boolean
    /** 输入框的 id，便于 `Label` 关联。 */
    id?: string
    /** 值变化时的回调。 */
    onchange?: (value: string[]) => void
  }

  let { value = $bindable([]), placeholder, numeric = false, id, onchange }: Props = $props()

  let draft = $state("")

  /** 加一个标签：重复的忽略，非法的提示一句。 */
  function add(): void {
    const raw = draft.trim()
    if (!raw) return
    if (numeric && !/^\d+$/.test(raw)) {
      draft = ""
      return
    }
    if (!value.includes(raw)) value = [...value, raw]
    draft = ""
    onchange?.(value)
  }

  /** 删掉一个标签。 */
  function remove(item: string): void {
    value = value.filter((entry) => entry !== item)
    onchange?.(value)
  }

  /** 回车或逗号都算加标签。 */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault()
      add()
    }
  }
</script>

<div class="flex flex-wrap items-center gap-2">
  {#each value as item (item)}
    <Badge variant="secondary" class="gap-1">
      {item}
      <button
        type="button"
        class="hover:text-destructive"
        aria-label={`删除 ${item}`}
        onclick={() => remove(item)}
      >
        <X class="size-3" />
      </button>
    </Badge>
  {/each}
  <Input
    {id}
    class="h-8 w-40"
    bind:value={draft}
    {placeholder}
    inputmode={numeric ? "numeric" : "text"}
    onkeydown={onKeydown}
    onblur={add}
  />
</div>
