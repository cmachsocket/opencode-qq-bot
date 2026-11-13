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
  import type { DocumentResponse, ToolPolicyFile } from "$lib/types"

  interface Props {
    /** 需要重启才能生效时的回调。 */
    onrestart?: (paths: string[]) => void
  }

  let { onrestart }: Props = $props()

  let doc = $state<DocumentResponse | undefined>(undefined)
  let loading = $state(true)
  let busy = $state(false)
  let message = $state("")
  let tone = $state<"ok" | "error">("ok")
  let warnings = $state<string[]>([])
  let errors = $state<Record<string, string>>({})

  /** 正在编辑的配置档名；空串表示新增。 */
  let editing = $state<string | undefined>(undefined)
  let nameInput = $state("")
  let allowInput = $state<string[]>([])
  let denyInput = $state<string[]>([])

  /** 正在编辑的聊天映射；空串表示新增。 */
  let mapping = $state<string | undefined>(undefined)
  let mappingKey = $state("")
  let mappingProfile = $state("")

  /** 生效的工具配置。 */
  let policy = $derived((doc?.value as ToolPolicyFile | undefined) ?? undefined)
  /** 文件里写着的配置档：不在这里的都是内置档。 */
  let fileProfiles = $derived(
    ((doc?.fileValue as ToolPolicyFile | undefined)?.profiles ?? {}) as Record<
      string,
      { allow: string[]; deny: string[] }
    >,
  )
  /** 所有可用的配置档名。 */
  let profileNames = $derived(Object.keys(policy?.profiles ?? {}))

  onMount(() => {
    void load()
  })

  /** 读取文件内容。 */
  async function load(): Promise<void> {
    loading = true
    try {
      doc = await api.toolProfiles()
      warnings = doc.warnings ?? []
      message = ""
      tone = "ok"
    } catch (cause) {
      fail(cause)
    } finally {
      loading = false
    }
  }

  /** 这个字段是否被掩码：值里有已知凭证，不回显。 */
  function isMasked(path: string): boolean {
    return (doc?.masked ?? []).includes(path)
  }

  /** 配置档是不是内置的：文件里没写就是内置档。 */
  function isBuiltin(name: string): boolean {
    return !Object.hasOwn(fileProfiles, name)
  }

  /** 编辑一个配置档。 */
  function edit(name: string): void {
    const profile = policy?.profiles?.[name]
    editing = name
    nameInput = name
    allowInput = listValue(profile?.allow)
    denyInput = listValue(profile?.deny)
    // 被掩码的列表不把占位符带进表单：留空即表示不修改。
    if (isMasked(`profiles.${name}.allow`)) allowInput = []
    if (isMasked(`profiles.${name}.deny`)) denyInput = []
    errors = {}
    message = ""
  }

  /** 新增一个配置档。 */
  function create(): void {
    editing = ""
    nameInput = ""
    allowInput = []
    denyInput = []
    errors = {}
    message = ""
  }

  /** 关闭配置档表单。 */
  function cancel(): void {
    editing = undefined
    errors = {}
  }

  /** 保存配置档。 */
  async function saveProfile(): Promise<void> {
    const name = nameInput.trim()
    if (name === "") {
      errors = { name: "请填写配置档名字" }
      tone = "error"
      message = "配置档名字不能为空"
      return
    }
    const entry: Record<string, unknown> = {}
    if (!(isMasked(`profiles.${name}.allow`) && allowInput.length === 0)) {
      entry.allow = allowInput
    }
    if (!(isMasked(`profiles.${name}.deny`) && denyInput.length === 0)) {
      entry.deny = denyInput
    }
    busy = true
    try {
      const result = await api.saveToolProfiles({ profiles: { [name]: entry } })
      doc = result.document
      warnings = result.warnings ?? []
      editing = undefined
      errors = {}
      tone = "ok"
      message = result.restartRequired ? result.note : `已保存。${result.note}`
      if (result.restartRequired) onrestart?.([`tool-profiles:${name}`])
    } catch (cause) {
      fail(cause)
    } finally {
      busy = false
    }
  }

  /** 删掉一个配置档。 */
  async function removeProfile(name: string): Promise<void> {
    busy = true
    try {
      const result = await api.saveToolProfiles({ profiles: { [name]: null } })
      doc = result.document
      warnings = result.warnings ?? []
      errors = {}
      tone = "ok"
      message = `已删除配置档 ${name}。${result.note}`
      if (editing === name) editing = undefined
    } catch (cause) {
      fail(cause)
    } finally {
      busy = false
    }
  }

  /** 改默认配置档。 */
  async function saveDefault(name: string): Promise<void> {
    busy = true
    try {
      const result = await api.saveToolProfiles({ defaultProfile: name })
      doc = result.document
      warnings = result.warnings ?? []
      errors = {}
      tone = "ok"
      message = result.restartRequired ? result.note : `已保存。${result.note}`
      if (result.restartRequired) onrestart?.(["tool-profiles:defaultProfile"])
    } catch (cause) {
      fail(cause)
    } finally {
      busy = false
    }
  }

  /** 编辑一个聊天映射。 */
  function editMapping(key: string): void {
    mapping = key
    mappingKey = key
    mappingProfile = policy?.chats?.[key] ?? ""
    errors = {}
    message = ""
  }

  /** 新增一个聊天映射。 */
  function createMapping(): void {
    mapping = ""
    mappingKey = ""
    mappingProfile = profileNames[0] ?? ""
    errors = {}
    message = ""
  }

  /** 关闭映射表单。 */
  function cancelMapping(): void {
    mapping = undefined
    errors = {}
  }

  /** 保存聊天映射。 */
  async function saveMapping(): Promise<void> {
    const key = mappingKey.trim()
    if (key === "") {
      errors = { mappingKey: "请填写聊天键" }
      tone = "error"
      message = "聊天键不能为空"
      return
    }
    if (mappingProfile === "") {
      errors = { mappingProfile: "请选择配置档" }
      tone = "error"
      message = "聊天映射要指向一个配置档"
      return
    }
    busy = true
    try {
      const result = await api.saveToolProfiles({ chats: { [key]: mappingProfile } })
      doc = result.document
      warnings = result.warnings ?? []
      mapping = undefined
      errors = {}
      tone = "ok"
      message = result.restartRequired ? result.note : `已保存。${result.note}`
      if (result.restartRequired) onrestart?.([`tool-profiles:chats.${key}`])
    } catch (cause) {
      fail(cause)
    } finally {
      busy = false
    }
  }

  /** 删掉一个聊天映射。 */
  async function removeMapping(key: string): Promise<void> {
    busy = true
    try {
      const result = await api.saveToolProfiles({ chats: { [key]: null } })
      doc = result.document
      warnings = result.warnings ?? []
      errors = {}
      tone = "ok"
      message = `已删除 ${key} 的映射。${result.note}`
      if (mapping === key) mapping = undefined
    } catch (cause) {
      fail(cause)
    } finally {
      busy = false
    }
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
        新增配置档
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
      {#each warnings as warning (warning)}
        <li>· {warning}</li>
      {/each}
    </ul>
  {/if}

  {#if loading}
    <p class="text-muted-foreground text-sm">正在读取工具配置…</p>
  {:else}
    <section class="space-y-3 rounded-lg border p-4">
      <h2 class="text-sm font-semibold">默认配置档</h2>
      <div class="flex flex-wrap items-center gap-2">
        <Select.Root
          type="single"
          value={policy?.defaultProfile ?? ""}
          onValueChange={(next) => {
            if (next) void saveDefault(next)
          }}
        >
          <Select.Trigger class="w-64">
            <Select.Value placeholder="选择默认配置档" />
          </Select.Trigger>
          <Select.Content>
            {#each profileNames as name (name)}
              <Select.Item value={name}>{name}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        <span class="text-muted-foreground text-xs">
          没有按聊天指定的配置档时用这一档。
        </span>
      </div>
      {#if errorFor("defaultProfile")}
        <p class="text-destructive text-xs">{errorFor("defaultProfile")}</p>
      {/if}
    </section>

    <section class="space-y-3 rounded-lg border p-4">
      <h2 class="text-sm font-semibold">配置档</h2>
      {#if profileNames.length === 0}
        <p class="text-muted-foreground text-sm">还没有任何配置档。</p>
      {:else}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>档名</Table.Head>
              <Table.Head>allow</Table.Head>
              <Table.Head>deny</Table.Head>
              <Table.Head></Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each profileNames as name (name)}
              <Table.Row>
                <Table.Cell class="font-mono text-xs">
                  {name}
                  {#if isBuiltin(name)}
                    <Badge variant="secondary" class="ml-1">内置</Badge>
                  {/if}
                </Table.Cell>
                <Table.Cell class="text-xs">
                  {isMasked(`profiles.${name}.allow`)
                    ? "已隐藏"
                    : (policy?.profiles?.[name]?.allow ?? []).join(" / ") || "-"}
                </Table.Cell>
                <Table.Cell class="text-xs">
                  {isMasked(`profiles.${name}.deny`)
                    ? "已隐藏"
                    : (policy?.profiles?.[name]?.deny ?? []).join(" / ") || "-"}
                </Table.Cell>
                <Table.Cell>
                  <div class="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onclick={() => edit(name)}>
                      <Pencil class="size-4" />
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || isBuiltin(name)}
                      onclick={() => void removeProfile(name)}
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
          {editing === "" ? "新增配置档" : `编辑配置档 ${editing}`}
        </h2>
        <div class="space-y-1.5">
          <Label for="profile-name" class="text-sm">档名</Label>
          <Input
            id="profile-name"
            value={nameInput}
            disabled={editing !== ""}
            placeholder="例如 readonly"
            oninput={(event) => (nameInput = event.currentTarget.value)}
          />
          {#if errorFor("profiles") || errorFor(`profiles.${nameInput.trim()}`)}
            <p class="text-destructive text-xs">
              {errorFor("profiles") || errorFor(`profiles.${nameInput.trim()}`)}
            </p>
          {/if}
        </div>
        <div class="grid gap-4 md:grid-cols-2">
          <div class="space-y-1.5">
            <Label for="profile-allow" class="text-sm">allow</Label>
            <TagInput
              id="profile-allow"
              value={allowInput}
              placeholder="工具名或通配符，输入后回车"
              onchange={(next) => (allowInput = next)}
            />
            <p class="text-muted-foreground text-xs">
              命中的工具才可用；写 <code>*</code> 表示全部。
            </p>
            {#if errorFor(`profiles.${nameInput.trim()}.allow`)}
              <p class="text-destructive text-xs">
                {errorFor(`profiles.${nameInput.trim()}.allow`)}
              </p>
            {/if}
          </div>
          <div class="space-y-1.5">
            <Label for="profile-deny" class="text-sm">deny</Label>
            <TagInput
              id="profile-deny"
              value={denyInput}
              placeholder="工具名或通配符，输入后回车"
              onchange={(next) => (denyInput = next)}
            />
            <p class="text-muted-foreground text-xs">deny 优先于 allow。</p>
            {#if errorFor(`profiles.${nameInput.trim()}.deny`)}
              <p class="text-destructive text-xs">
                {errorFor(`profiles.${nameInput.trim()}.deny`)}
              </p>
            {/if}
          </div>
        </div>
        <div class="flex items-center gap-2">
          <Button size="sm" disabled={busy} onclick={() => void saveProfile()}>
            <Save class="size-4" />
            保存
          </Button>
          <Button variant="ghost" size="sm" onclick={cancel}>取消</Button>
        </div>
      </section>
    {/if}

    <section class="space-y-3 rounded-lg border p-4">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold">聊天映射</h2>
        <Button variant="ghost" size="sm" class="ml-auto" onclick={createMapping}>
          <Plus class="size-4" />
          新增映射
        </Button>
      </div>
      {#if Object.keys(policy?.chats ?? {}).length === 0}
        <p class="text-muted-foreground text-sm">没有按聊天的映射，全部用默认配置档。</p>
      {:else}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>聊天键</Table.Head>
              <Table.Head>配置档</Table.Head>
              <Table.Head></Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each Object.entries(policy?.chats ?? {}) as [key, name] (key)}
              <Table.Row>
                <Table.Cell class="font-mono text-xs">{key}</Table.Cell>
                <Table.Cell>
                  <Badge variant="outline">{name}</Badge>
                </Table.Cell>
                <Table.Cell>
                  <div class="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onclick={() => editMapping(key)}>
                      <Pencil class="size-4" />
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onclick={() => void removeMapping(key)}
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

    {#if mapping !== undefined}
      <section class="space-y-3 rounded-lg border p-4">
        <h2 class="text-sm font-semibold">
          {mapping === "" ? "新增聊天映射" : `编辑映射 ${mapping}`}
        </h2>
        <div class="grid gap-4 md:grid-cols-2">
          <div class="space-y-1.5">
            <Label for="mapping-key" class="text-sm">聊天键</Label>
            <Input
              id="mapping-key"
              value={mappingKey}
              disabled={mapping !== ""}
              placeholder="group:100 或 private:200"
              oninput={(event) => (mappingKey = event.currentTarget.value)}
            />
            <p class="text-muted-foreground text-xs">只能是 group:群号 或 private:账号。</p>
            {#if errorFor("chats") || errorFor(`chats.${mappingKey.trim()}`)}
              <p class="text-destructive text-xs">
                {errorFor("chats") || errorFor(`chats.${mappingKey.trim()}`)}
              </p>
            {/if}
          </div>
          <div class="space-y-1.5">
            <Label for="mapping-profile" class="text-sm">配置档</Label>
            <Select.Root
              type="single"
              value={mappingProfile}
              onValueChange={(next) => (mappingProfile = next ?? "")}
            >
              <Select.Trigger id="mapping-profile" class="w-full">
                <Select.Value placeholder="选择配置档" />
              </Select.Trigger>
              <Select.Content>
                {#each profileNames as name (name)}
                  <Select.Item value={name}>{name}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            {#if errorFor(`chats.${mappingKey.trim()}`)}
              <p class="text-destructive text-xs">{errorFor(`chats.${mappingKey.trim()}`)}</p>
            {/if}
          </div>
        </div>
        <div class="flex items-center gap-2">
          <Button size="sm" disabled={busy} onclick={() => void saveMapping()}>
            <Save class="size-4" />
            保存
          </Button>
          <Button variant="ghost" size="sm" onclick={cancelMapping}>取消</Button>
        </div>
      </section>
    {/if}
  {/if}
</div>
