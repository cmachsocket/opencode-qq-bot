declare module "*.svelte" {
  import type { Component } from "svelte"

  /** 组件的具体类型由 svelte-check 负责，这里只要能挂载。 */
  const component: Component<Record<string, unknown>>
  export default component
}
