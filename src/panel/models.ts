/**
 * 可用模型列表。
 *
 * 候选模型来自 OpenCode 的 provider 配置与模型目录，不在插件的配置里；
 * 插件只是借 `ctx.model` 转述，模型列表变了要重载插件才会同步。
 */

/** 面板展示的模型。 */
export interface ModelInfo {
  /** provider id。 */
  providerID: string
  /** 模型 id。 */
  id: string
  /** 展示名。 */
  name: string
  /** 是否是 OpenCode 当前的默认模型。 */
  default: boolean
}

/** 模型列表的来源。 */
export interface ModelProvider {
  /** 取当前可用的模型。 */
  list(): Promise<ModelInfo[]>
}

/** OpenCode 的模型接口：只用 list 与 default 两个方法。 */
interface ModelApiLike {
  list(): Promise<{ data?: Array<{ providerID?: string; id?: string; name?: string }> }>
  default(): Promise<{ data?: { providerID?: string; id?: string } | null }>
}

/**
 * 把 OpenCode 的模型接口包成面板要的形状。
 *
 * @param api `ctx.model`。
 */
export function createModelProvider(api: ModelApiLike): ModelProvider {
  return {
    async list(): Promise<ModelInfo[]> {
      const listed = await api.list()
      const fallback = await api.default().catch(() => ({ data: null }))
      const current = fallback.data
      const models = listed.data ?? []
      return models.map((model) => ({
        providerID: model.providerID ?? "",
        id: model.id ?? "",
        name: model.name ?? `${model.providerID ?? ""}/${model.id ?? ""}`,
        default:
          current !== undefined &&
          current !== null &&
          current.providerID === model.providerID &&
          current.id === model.id,
      }))
    },
  }
}
