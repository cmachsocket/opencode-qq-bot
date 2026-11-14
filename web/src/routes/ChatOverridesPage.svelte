<script lang="ts">
  import { onMount } from "svelte"
  import { Pencil, Plus, Save, Trash2 } from "lucide-svelte"
  import { api, ApiError } from "$lib/api"
  import { Badge } from "$lib/components/ui/badge"
  import { Button } from "$lib/components/ui/button"
  import { Input } from "$lib/components/ui/input"
  import { Label } from "$lib/components/ui/label"
  import * as Select from "$lib/components/ui/select"
  import * as Table from "$lib/components/ui/table"
  import TagInput from "$lib/components/TagInput.svelte"
  import { listValue } from "$lib/fields"
  import type {
    ChatOverride,
    ChatOverridesFile,
    DocumentResponse,
    DocumentSaveResponse,
  } from "$lib/types"

  interface Props {
    /** 需要重启才能生效时的回调。 */
    onrestart?: (paths: string[]) => void
  }

  let { onrestart }: Props = $props()

  /** 可编辑的字段：与后端的 `ChatOverride` 一一对应，不多不少。 */
  const FIELDS = [
    { path: "wake", label: "唤醒方式", hint: "all / mention / prefix / none" },
    { path: "wake.prefixes", label: "唤醒前缀", hint: "wake 为 prefix 时用，留空表示不覆盖" },
    { path: "proactive.enabled", label: "主动说话", hint: "留空表示跟随全局白名单" },
    { path: "proactive.startProbability", label: "主动概率", hint: "0 到 1 之间的数字" },
    { path: "agent", label: "agent", hint: "覆盖这个聊天用的 agent" },
    { path: "model", label: "模型", hint: "provider/model[/variant]" },
    { path: "soulPath", label: "角色设定路径", hint: "覆盖 soulPath" },
    { path: "soulName", label: "角色设定文件名", hint: "覆盖 soulName" },
  ] as const

  /** 唤醒方式的候选项。 */
  const WAKE_MODES = ["all", "mention", "prefix", "none"]

  /** 下拉框里的「跟随默认」哨兵：单选下拉选中后清不掉，只能靠这个假值切回去。 */
  const EMPTY_CHOICE = "__empty__"

  let doc = $state<DocumentResponse | undefined>(undefined)
  let loading = $state(true)
  let busy = $state(false)
  let message = $state("")
  let tone = $state<"ok" | "error">("ok")
  let warnings = $state<string[]>([])
  let errors = $state<Record<string, string>>({})

  /** 正在编辑的聊天键；空串表示新增。 */
  let editing = $state<string | undefined>(undefined)
  let keyInput = $state("")
  let draft = $state<Record<string, unknown>>({})

  /** 生效的覆盖表。 */
  let chats = $derived((doc?.value as ChatOverridesFile | undefined)?.chats ?? {})

  onMount(() => {
    void load()
  })

  /** 读取文件内容。 */
  async function load(): Promise<void> {
    loading = true
    try {
      doc = await api.chatOverrides()
      warnings = doc.warnings ?? []
      message = ""
      tone = "ok"
    } catch (cause) {
      fail(cause)
    } finally {
      loading = false
    }
  }

  /** 把模型引用摊成字符串。 */
  function modelText(value: unknown): string {
    if (typeof value === "string") return value
    if (value && typeof value === "object") {
      const ref = value as { providerID?: string; id?: string; variant?: string }
      const base = `${ref.providerID ?? ""}/${ref.id ?? ""}`
      return ref.variant ? `${base}/${ref.variant}` : base
    }
    return ""
  }

  /** 这个字段是否被掩码：值里有已知凭证，不回显。 */
  function isMasked(path: string): boolean {
    return (doc?.masked ?? []).includes(path)
  }

  /** 打开编辑表单：填入这个聊天当前生效的覆盖。 */
  function edit(key: string): void {
    const override = chats[key]
    editing = key
    keyInput = key
    draft = {
      wake: override?.wake ?? "",
      "wake.prefixes": listValue(override?.["wake.prefixes"]),
      "proactive.enabled":
        override?.["proactive.enabled"] === undefined
          ? ""
          : String(override["proactive.enabled"]),
      "proactive.startProbability":
        override?.["proactive.startProbability"] === undefined
          ? ""
          : String(override["proactive.startProbability"]),
      agent: override?.agent ?? "",
      model: modelText(override?.model),
      soulPath: override?.soulPath ?? "",
      soulName: override?.soulName ?? "",
    }
    // 被掩码的字段不把占位符带进表单：留空即表示不修改。
    for (const field of FIELDS) {
      if (isMasked(`chats.${key}.${field.path}`)) draft[field.path] = ""
    }
    errors = {}
    message = ""
  }

  /** 新增一个聊天覆盖。 */
  function create(): void {
    editing = ""
    keyInput = ""
    draft = {
      wake: "",
      "wake.prefixes": [],
      "proactive.enabled": "",
      "proactive.startProbability": "",
      agent: "",
      model: "",
      soulPath: "",
      soulName: "",
    }
    errors = {}
    message = ""
  }

  /** 关闭编辑表单。 */
  function cancel(): void {
    editing = undefined
    errors = {}
  }

  /** 表单值变成补丁值：空表示删掉这个字段。 */
  function patchValue(path: string): unknown {
    const value = draft[path]
    if (path === "wake.prefixes") {
      const list = listValue(value)
      return list.length > 0 ? list : null
    }
    if (path === "proactive.enabled") {
      if (value === "true") return true
      if (value === "false") return false
      return null
    }
    if (path === "proactive.startProbability") {
      if (value === "" || value === undefined || value === null) return null
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : String(value)
    }
    const text = String(value ?? "").trim()
    return text === "" ? null : text
  }

  /** 保存这个聊天的覆盖。 */
  async function save(): Promise<void> {
    const key = keyInput.trim()
    if (key === "") {
      errors = { key: "请填写聊天键" }
      tone = "error"
      message = "聊天键不能为空"
      return
    }
    // 新增模式下这个键必须还不存在：存在时只有「编辑」能改它，
    // 否则新增表单里的空字段会把已有记录整条清空。
    const creating = editing === ""
    if (creating && Object.hasOwn(chats, key)) {
      errors = { key: "这个聊天已经有覆盖了，点「编辑」来改" }
      tone = "error"
      message = "这个聊天已经有覆盖了，点「编辑」来改"
      return
    }
    if (draft.wake === "prefix" && listValue(draft["wake.prefixes"]).length === 0) {
      errors = { [`chats.${key}.wake.prefixes`]: "选择 prefix 唤醒时必须写至少一个前缀" }
      tone = "error"
      message = "选择 prefix 唤醒时必须写至少一个前缀"
      return
    }
    const entry: Record<string, unknown> = {}
    for (const field of FIELDS) {
      // 被掩码的字段留空时不提交：原值保持不变。
      if (isMasked(`chats.${key}.${field.path}`) && isBlank(draft[field.path])) continue
      const value = patchValue(field.path)
      // 新增时只提交真填了的字段：空字段不能把同名已有记录清空。
      if (creating && value === null) continue
      entry[field.path] = value
    }
    if (Object.keys(entry).length === 0) {
      errors = { key: "至少填写一项再保存" }
      tone = "error"
      message = "至少填写一项再保存"
      return
    }
    busy = true
    try {
      const result = await api.saveChatOverrides({ chats: { [key]: entry } })
      doc = result.document
      warnings = result.warnings ?? []
      editing = undefined
      errors = {}
      tone = "ok"
      message = result.restartRequired ? result.note : `已保存。${result.note}`
      if (result.restartRequired) onrestart?.([`chat-overrides:${key}`])
    } catch (cause) {
      fail(cause)
    } finally {
      busy = false
    }
  }

  /** 删掉一个聊天的覆盖。 */
  async function remove(key: string): Promise<void> {
    busy = true
    try {
      const result = await api.saveChatOverrides({ chats: { [key]: null } })
      doc = result.document
      warnings = result.warnings ?? []
      errors = {}
      tone = "ok"
      message = `已删除 ${key}。${result.note}`
      if (editing === key) editing = undefined
    } catch (cause) {
      fail(cause)
    } finally {
      busy = false
    }
  }

  /** 值是不是空的。 */
  function isBlank(value: unknown): boolean {
    if (value === undefined || value === null) return true
    if (Array.isArray(value)) return value.length === 0
    return String(value).trim() === ""
  }

  /** 统一处理错误：逐字段的原因就地显示。 */
  function fail(cause: unknown): void {
    tone = "error"
    if (cause instanceof ApiError) {
      if (cause.fields.length > 0) {
        const next: Record<string, string> = {}
        for (const field of cause.fields) next[field.path] = field.message
        errors = next
        message = cause.fields.map((field) => field.message).join("；")
      } else {
        message = cause.message
      }
      return
    }
    message = cause instanceof Error ? cause.message : String(cause)
  }

  /** 某个字段的错误说明。 */
  function errorFor(path: string): string {
    return errors[path] ?? ""
  }

  /** 表格里的摘要文本。 */
  function summary(value: unknown): string {
    if (value === undefined || value === null || value === "") return "-"
    if (Array.isArray(value)) return value.length > 0 ? value.join(" / ") : "-"
    return String(value)
  }
</script>

<div class="flex flex-col gap-4">
  <div class="flex flex-wrap items-center gap-2">
    <span class="text-muted-foreground font-mono text-xs">{doc?.path ?? "-"}</span>
    {#if doc && !doc.exists}
      <Badge variant="outline">文件不存在，保存后新建</Badge>
    {/if}
    <div class="ml-auto flex items-center gap-2">
      <Button variant="ghost" size="sm" onclick={() => void load()}>重新读取</Button>
      <Button size="sm" onclick={create}>
        <Plus class="size-4" />
        新增聊天
      </Button>
    </div>
  </div>

  {#if message}
    <p class={tone === "error" ? "text-destructive text-sm" : "text-emerald-600 text-sm"}>
      {message}
    </p>
  {/if}
  {#if warnings.length > 0}
    <ul class="text-muted-foreground space-y-1 text-xs">
      {#each warnings as warning, index (index)}
        <li>· {warning}</li>
      {/each}
    </ul>
  {/if}

  {#if loading}
    <p class="text-muted-foreground text-sm">正在读取会话覆盖…</p>
  {:else}
    <section class="space-y-3 rounded-lg border p-4">
      <h2 class="text-sm font-semibold">聊天覆盖</h2>
      {#if Object.keys(chats).length === 0}
        <p class="text-muted-foreground text-sm">还没有任何覆盖，全部按默认行为走。</p>
      {:else}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>聊天键</Table.Head>
              <Table.Head>唤醒</Table.Head>
              <Table.Head>前缀</Table.Head>
              <Table.Head>主动</Table.Head>
              <Table.Head>概率</Table.Head>
              <Table.Head>agent</Table.Head>
              <Table.Head>模型</Table.Head>
              <Table.Head>角色设定</Table.Head>
              <Table.Head></Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each Object.entries(chats) as [key, override] (key)}
              <Table.Row>
                <Table.Cell class="font-mono text-xs">{key}</Table.Cell>
                <Table.Cell>{summary(override.wake)}</Table.Cell>
                <Table.Cell class="text-xs">{summary(override["wake.prefixes"])}</Table.Cell>
                <Table.Cell>
                  {override["proactive.enabled"] === undefined
                    ? "默认"
                    : override["proactive.enabled"]
                      ? "开"
                      : "关"}
                </Table.Cell>
                <Table.Cell>{summary(override["proactive.startProbability"])}</Table.Cell>
                <Table.Cell class="text-xs">{summary(override.agent)}</Table.Cell>
                <Table.Cell class="text-xs">{summary(modelText(override.model))}</Table.Cell>
                <Table.Cell class="text-xs">
                  {summary(override.soulPath ?? override.soulName)}
                </Table.Cell>
                <Table.Cell>
                  <div class="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onclick={() => edit(key)}>
                      <Pencil class="size-4" />
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onclick={() => void remove(key)}
                    >
                      <Trash2 class="size-4" />
                      删除
                    </Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {/if}
    </section>

    {#if editing !== undefined}
      <section class="space-y-3 rounded-lg border p-4">
        <h2 class="text-sm font-semibold">
          {editing === "" ? "新增聊天覆盖" : `编辑 ${editing}`}
        </h2>
        <div class="space-y-1.5">
          <Label for="chat-key" class="text-sm">聊天键</Label>
          <Input
            id="chat-key"
            value={keyInput}
            disabled={editing !== ""}
            placeholder="group:100 或 private:200"
            oninput={(event) => (keyInput = event.currentTarget.value)}
          />
          {#if errorFor("chats") || errorFor(`chats.${keyInput.trim()}`)}
            <p class="text-destructive text-xs">
              {errorFor("chats") || errorFor(`chats.${keyInput.trim()}`)}
            </p>
          {/if}
        </div>

        <div class="grid gap-4 md:grid-cols-2">
          {#each FIELDS as field (field.path)}
            <div class="space-y-1.5">
              <Label for={`chat-${field.path}`} class="text-sm">{field.label}</Label>
              {#if field.path === "wake"}
                <Select.Root
                  type="single"
                  value={String(draft[field.path] ?? "") === "" ? EMPTY_CHOICE : String(draft[field.path])}
                  onValueChange={(next) =>
                    (draft[field.path] = next === EMPTY_CHOICE ? "" : (next ?? ""))}
                >
                  <Select.Trigger id={`chat-${field.path}`} class="w-full">
                    <Select.Value placeholder="跟随默认" />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value={EMPTY_CHOICE}>跟随默认</Select.Item>
                    {#each WAKE_MODES as mode (mode)}
                      <Select.Item value={mode}>{mode}</Select.Item>
                    {/each}
                  </Select.Content>
                </Select.Root>
              {:else if field.path === "wake.prefixes"}
                <TagInput
                  id={`chat-${field.path}`}
                  value={listValue(draft[field.path])}
                  placeholder="输入前缀后回车"
                  onchange={(next) => (draft[field.path] = next)}
                />
              {:else if field.path === "proactive.enabled"}
                <Select.Root
                  type="single"
                  value={String(draft[field.path] ?? "") === "" ? EMPTY_CHOICE : String(draft[field.path])}
                  onValueChange={(next) =>
                    (draft[field.path] = next === EMPTY_CHOICE ? "" : (next ?? ""))}
                >
                  <Select.Trigger id={`chat-${field.path}`} class="w-full">
                    <Select.Value placeholder="跟随默认" />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value={EMPTY_CHOICE}>跟随默认</Select.Item>
                    <Select.Item value="true">允许</Select.Item>
                    <Select.Item value="false">不允许</Select.Item>
                  </Select.Content>
                </Select.Root>
              {:else if field.path === "proactive.startProbability"}
                <Input
                  id={`chat-${field.path}`}
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={String(draft[field.path] ?? "")}
                  oninput={(event) => (draft[field.path] = event.currentTarget.value)}
                />
              {:else}
                <Input
                  id={`chat-${field.path}`}
                  type="text"
                  value={String(draft[field.path] ?? "")}
                  placeholder={isMasked(`chats.${keyInput.trim()}.${field.path}`)
                    ? "已隐藏，留空表示不修改"
                    : "留空表示不覆盖"}
                  oninput={(event) => (draft[field.path] = event.currentTarget.value)}
                />
              {/if}
              <p class="text-muted-foreground text-xs">{field.hint}</p>
              {#if errorFor(`chats.${keyInput.trim()}.${field.path}`)}
                <p class="text-destructive text-xs">
                  {errorFor(`chats.${keyInput.trim()}.${field.path}`)}
                </p>
              {/if}
            </div>
          {/each}
        </div>

        <div class="flex items-center gap-2">
          <Button size="sm" disabled={busy} onclick={() => void save()}>
            <Save class="size-4" />
            保存
          </Button>
          <Button variant="ghost" size="sm" onclick={cancel}>取消</Button>
        </div>
      </section>
    {/if}
  {/if}
</div>
