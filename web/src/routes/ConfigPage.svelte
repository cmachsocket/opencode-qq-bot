<script lang="ts">
  import Ajv from "ajv"
  import { onMount } from "svelte"
  import { RotateCcw, Save, Search } from "lucide-svelte"
  import { api, ApiError } from "$lib/api"
  import { Badge } from "$lib/components/ui/badge"
  import { Button } from "$lib/components/ui/button"
  import { Input } from "$lib/components/ui/input"
  import { Label } from "$lib/components/ui/label"
  import * as Select from "$lib/components/ui/select"
  import { Switch } from "$lib/components/ui/switch"
  import TagInput from "$lib/components/TagInput.svelte"
  import { listValue, numberValue, setPath } from "$lib/fields"
  import type {
    ConfigResponse,
    FieldMeta,
    FieldView,
    ModelInfo,
    SchemaResponse,
  } from "$lib/types"

  interface Props {
    /** 服务端推送的最新生效值。 */
    config?: ConfigResponse
    /** 有字段需要重启才能生效时的回调。 */
    onrestart?: (paths: string[]) => void
  }

  let { config, onrestart }: Props = $props()

  const ajv = new Ajv({ allErrors: true, strict: false })

  let schema = $state<SchemaResponse>()
  let models = $state<ModelInfo[]>([])
  let values = $state<Record<string, unknown>>({})
  let originals = $state<Record<string, unknown>>({})
  let dirty = $state<string[]>([])
  let errors = $state<Record<string, string>>({})
  let message = $state("")
  let tone = $state<"ok" | "error">("ok")
  let busy = $state(false)
  let loading = $state(true)
  let search = $state("")
  let modelError = $state("")
  let secretSet = $state<Record<string, boolean>>({})
  let applied: ConfigResponse | undefined

  /** 字段索引：渲染与补丁组装都要用。 */
  let fieldByPath = $derived(
    new Map((schema?.fields ?? []).map((field) => [field.path, field])),
  )

  /** 按搜索词过滤后的分组。 */
  let groups = $derived(
    (schema?.groups ?? []).map((group) => ({
      ...group,
      fields: (schema?.fields ?? []).filter(
        (field) =>
          field.group === group.id &&
          (search.trim() === "" ||
            field.path.includes(search.trim()) ||
            field.label.includes(search.trim()) ||
            (field.description ?? "").includes(search.trim())),
      ),
    })),
  )

  onMount(() => {
    void load()
  })

  // 服务端推送的配置变化：没有本地未保存改动时才覆盖表单。
  $effect(() => {
    const next = config
    if (!next || next === applied) return
    if (dirty.length > 0) return
    applied = next
    applyView(next.fields)
  })

  /** 首次加载：字段元数据、生效值与模型列表。 */
  async function load(): Promise<void> {
    loading = true
    try {
      const [meta, current] = await Promise.all([api.schema(), api.config()])
      schema = meta
      applyView(current.fields)
      try {
        models = (await api.models()).models
      } catch (cause) {
        modelError = cause instanceof Error ? cause.message : String(cause)
      }
    } catch (cause) {
      fail(cause)
    } finally {
      loading = false
    }
  }

  /** 把接口返回的字段视图摊成「路径 → 值」。 */
  function applyView(fields: FieldView[]): void {
    const next: Record<string, unknown> = {}
    const secrets: Record<string, boolean> = {}
    for (const view of fields) {
      const field = fieldByPath.get(view.path)
      if (!field) continue
      next[view.path] = field.secret ? "" : view.value
      if (field.secret) secrets[view.path] = view.hasValue === true
    }
    values = next
    originals = { ...next }
    secretSet = secrets
    dirty = []
    errors = {}
  }

  /** 改一个值：记下脏字段，等用户点保存。 */
  function update(field: FieldMeta, value: unknown): void {
    values[field.path] = value
    delete errors[field.path]
    if (!dirty.includes(field.path)) dirty = [...dirty, field.path]
    message = ""
  }

  /** 还原一个字段到服务端给的值。 */
  function reset(path: string): void {
    values[path] = originals[path]
    dirty = dirty.filter((entry) => entry !== path)
    delete errors[path]
  }

  /** 全部还原。 */
  function resetAll(): void {
    values = { ...originals }
    dirty = []
    errors = {}
    message = ""
  }

  /** 某个字段当前是否改过。 */
  function isDirty(path: string): boolean {
    return dirty.includes(path)
  }

  /** 把界面值规整成补丁值。 */
  function normalize(field: FieldMeta, value: unknown): unknown {
    switch (field.type) {
      case "number": {
        if (value === "" || value === undefined || value === null) return null
        const parsed = typeof value === "number" ? value : Number(value)
        return Number.isFinite(parsed) ? parsed : null
      }
      case "numberList":
        return listValue(value).map((item) => Number(item)).filter((item) => Number.isFinite(item))
      case "stringList":
      case "enum":
        return Array.isArray(value) ? value : String(value ?? "")
      case "modelRef":
      case "text":
      case "path":
      case "clock":
        return typeof value === "string" && value.trim() !== "" ? value.trim() : null
      case "secret":
        return typeof value === "string" && value !== "" ? value : undefined
      default:
        return value
    }
  }

  /** 组装校验用的完整候选对象。 */
  function candidate(): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const field of schema?.fields ?? []) {
      if (field.secret) continue
      const value = values[field.path]
      if (value === undefined || value === null || value === "") continue
      setPath(result, field.path, value)
    }
    return result
  }

  /** 用服务端给的 JSON Schema 校验，规则只有一份。 */
  function validate(next: Record<string, unknown>): Record<string, string> {
    if (!schema) return {}
    const validateFn = ajv.compile(schema.jsonSchema)
    if (validateFn(next)) return {}
    const found: Record<string, string> = {}
    for (const issue of validateFn.errors ?? []) {
      const path = issue.instancePath.replace(/^\//, "").replace(/\//g, ".")
      if (path) found[path] = issue.message ?? "取值不合法"
    }
    return found
  }

  /** 保存：只提交改过的字段。 */
  async function save(): Promise<void> {
    if (dirty.length === 0) {
      message = "没有需要保存的改动"
      tone = "ok"
      return
    }
    const patch: Record<string, unknown> = {}
    for (const path of dirty) {
      const field = fieldByPath.get(path)
      if (!field) continue
      const value = normalize(field, values[path])
      if (value === undefined) continue
      patch[path] = field.secret ? value : value
    }
    if (Object.keys(patch).length === 0) {
      message = "没有需要保存的改动"
      tone = "ok"
      return
    }
    const found = validate(candidate())
    if (Object.keys(found).length > 0) {
      errors = found
      message = "校验不通过，请检查标红的字段"
      tone = "error"
      return
    }
    busy = true
    try {
      const result = await api.save(patch)
      applyView(result.fields)
      if (result.restartRequired.length > 0) {
        message = `已保存；以下字段需要重启插件后生效：${result.restartRequired.join("、")}`
        onrestart?.(result.restartRequired)
      } else {
        message = "已保存并立即生效"
      }
      tone = "ok"
    } catch (cause) {
      if (cause instanceof ApiError) {
        message = cause.message
      } else {
        message = cause instanceof Error ? cause.message : String(cause)
      }
      tone = "error"
    } finally {
      busy = false
    }
  }

  /** 统一处理加载错误。 */
  function fail(cause: unknown): void {
    message = cause instanceof Error ? cause.message : String(cause)
    tone = "error"
  }

  /** 枚举与模型下拉的候选值。 */
  function choices(field: FieldMeta): string[] {
    if (field.type === "modelRef") {
      const list = models.map((model) => `${model.providerID}/${model.id}`)
      const current = String(values[field.path] ?? "")
      return current && !list.includes(current) ? [current, ...list] : list
    }
    return field.options ?? []
  }

  /** 下拉控件用哨兵值表示「留空跟随默认」。 */
  const EMPTY_CHOICE = "__empty__"
</script>

<div class="flex flex-col gap-4">
  <div class="flex flex-wrap items-center gap-2">
    <div class="relative">
      <Search class="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
      <Input class="w-64 pl-8" bind:value={search} placeholder="搜索字段名或说明" />
    </div>
    <span class="text-muted-foreground text-sm">
      {#if dirty.length > 0}
        {dirty.length} 项待保存
      {:else}
        全部为已保存的值
      {/if}
    </span>
    <div class="ml-auto flex items-center gap-2">
      <Button variant="ghost" size="sm" disabled={dirty.length === 0} onclick={resetAll}>
        <RotateCcw class="size-4" />
        还原
      </Button>
      <Button size="sm" disabled={busy || dirty.length === 0} onclick={() => void save()}>
        <Save class="size-4" />
        保存
      </Button>
    </div>
  </div>

  {#if message}
    <p class={tone === "error" ? "text-destructive text-sm" : "text-emerald-600 text-sm"}>
      {message}
    </p>
  {/if}

  {#if loading}
    <p class="text-muted-foreground text-sm">正在读取配置…</p>
  {:else if !schema}
    <p class="text-muted-foreground text-sm">字段元数据加载失败。</p>
  {:else}
    {#each groups as group (group.id)}
      {#if group.fields.length > 0}
        <section class="space-y-3 rounded-lg border p-4">
          <h2 class="text-sm font-semibold">{group.label}</h2>
          <div class="grid gap-4 md:grid-cols-2">
            {#each group.fields as field (field.path)}
              <div class="space-y-1.5">
                <div class="flex items-center gap-2">
                  <Label for={`field-${field.path}`} class="text-sm">
                    {field.label}
                  </Label>
                  {#if isDirty(field.path)}
                    <Badge variant="outline">待保存</Badge>
                  {/if}
                  {#if !field.hot}
                    <Badge variant="secondary">需重启</Badge>
                  {/if}
                  {#if isDirty(field.path)}
                    <button
                      type="button"
                      class="text-muted-foreground hover:text-foreground ml-auto text-xs"
                      onclick={() => reset(field.path)}
                    >
                      还原
                    </button>
                  {/if}
                </div>

                {#if field.type === "boolean"}
                  <div class="flex h-9 items-center">
                    <Switch
                      id={`field-${field.path}`}
                      checked={values[field.path] === true}
                      onCheckedChange={(next) => update(field, next)}
                    />
                  </div>
                {:else if field.type === "enum" || field.type === "modelRef"}
                  {@const options = choices(field)}
                  <Select.Root
                    type="single"
                    value={String(values[field.path] ?? "") || EMPTY_CHOICE}
                    onValueChange={(next) =>
                      update(field, next === EMPTY_CHOICE ? "" : (next ?? ""))}
                  >
                    <Select.Trigger id={`field-${field.path}`} class="w-full">
                      <Select.Value placeholder="跟随默认" />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value={EMPTY_CHOICE}>跟随默认</Select.Item>
                      {#each options as option (option)}
                        <Select.Item value={option}>{option}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                {:else if field.type === "secret"}
                  <Input
                    id={`field-${field.path}`}
                    type="password"
                    value={String(values[field.path] ?? "")}
                    placeholder={secretSet[field.path]
                      ? "已设置；留空表示不修改"
                      : "未设置；留空表示不修改"}
                    oninput={(event) => update(field, event.currentTarget.value)}
                  />
                {:else if field.type === "number"}
                  <Input
                    id={`field-${field.path}`}
                    type="number"
                    value={numberValue(values[field.path])}
                    min={field.min}
                    max={field.max}
                    step={field.step ?? 1}
                    oninput={(event) => {
                      const raw = event.currentTarget.value
                      update(field, raw === "" ? "" : Number(raw))
                    }}
                  />
                {:else if field.type === "numberList" || field.type === "stringList"}
                  <TagInput
                    value={listValue(values[field.path])}
                    numeric={field.type === "numberList"}
                    placeholder={field.type === "numberList" ? "输入数字后回车" : "输入后回车"}
                    onchange={(next) => update(field, next)}
                  />
                {:else if field.type === "clock"}
                  <Input
                    id={`field-${field.path}`}
                    type="time"
                    value={String(values[field.path] ?? "")}
                    oninput={(event) => update(field, event.currentTarget.value)}
                  />
                {:else}
                  <Input
                    id={`field-${field.path}`}
                    type="text"
                    value={String(values[field.path] ?? "")}
                    placeholder={field.type === "path" ? "留空使用默认路径" : "留空使用默认值"}
                    oninput={(event) => update(field, event.currentTarget.value)}
                  />
                {/if}

                {#if field.description}
                  <p class="text-muted-foreground text-xs">{field.description}</p>
                {/if}
                {#if errors[field.path]}
                  <p class="text-destructive text-xs">{errors[field.path]}</p>
                {/if}
                <p class="text-muted-foreground font-mono text-[11px]">{field.path}</p>
              </div>
            {/each}
          </div>
        </section>
      {/if}
    {/each}

    {#if modelError}
      <p class="text-muted-foreground text-xs">模型列表读取失败：{modelError}</p>
    {/if}
    {#if search.trim() && groups.every((group) => group.fields.length === 0)}
      <p class="text-muted-foreground text-sm">没有匹配的字段。</p>
    {/if}
  {/if}
</div>
