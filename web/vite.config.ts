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
      "/api": "http://127.0.0.1:7391",
    },
  },
})
