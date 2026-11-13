/**
 * jsdom 缺的那几个浏览器 API。
 *
 * bits-ui 的浮层与测量逻辑会用到它们；缺了会在挂载时就报错。
 */

import { cleanup } from "@testing-library/svelte"
import { afterEach } from "vitest"

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = ResizeObserverStub
}

if (!globalThis.matchMedia) {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof globalThis.matchMedia
}

if (!globalThis.scrollTo) {
  globalThis.scrollTo = (() => {}) as typeof globalThis.scrollTo
}

// 测试之间清掉挂载过的组件：DOM 是全局的，残留会串到下一个用例。
afterEach(() => {
  cleanup()
})
