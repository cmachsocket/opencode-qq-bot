import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * 两组测试：
 *
 * - `node`：后端、配置、面板接口，跑在 Node 环境；
 * - `web`：面板前端的 Svelte 组件，跑在 jsdom 里，组件按 Svelte 5 的方式编译。
 *
 * 组件测试的文件仍放在 `tests/` 下（`tests/web/`），与仓库约定一致。
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/web/**/*.test.ts"],
        },
      },
      {
        plugins: [svelte({ preprocess: vitePreprocess() })],
        resolve: {
          alias: { $lib: fileURLToPath(new URL("./web/src/lib", import.meta.url)) },
          // 组件与测试要共用同一份 svelte 运行时，否则上下文对不上。
          dedupe: ["svelte"],
          // 浏览器条件：svelte 会解析到客户端版本，组件才能真正挂载。
          conditions: ["browser"],
        },
        test: {
          name: "web",
          include: ["tests/web/**/*.test.ts"],
          environment: "jsdom",
          setupFiles: ["tests/web/setup.ts"],
          server: {
            deps: {
              // 前端的依赖（bits-ui、lucide 等）直接带 .svelte 或无扩展名的相对导入，
              // 交给 Vite 解析才跑得起来。
              inline: true,
            },
          },
        },
      },
    ],
  },
})
