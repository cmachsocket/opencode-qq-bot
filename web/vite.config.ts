import { svelte } from "@sveltejs/vite-plugin-svelte"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

/** 面板前端：构建产物进 `web/dist`，随 npm 包分发。 */
export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // 面板是本地工具，产物不需要长期缓存。
    assetsDir: "assets",
  },
  server: {
    proxy: {
      // 开发时面板跑在插件进程里：端口跟 config.json 的 panel.port 对齐。
      "/api": `http://127.0.0.1:${process.env.PANEL_PORT ?? "7391"}`,
    },
  },
})
