/**
 * Vitest 配置（T1：编辑器切换关键路径的单元测试基础设施）
 *
 * 设计要点：
 *   - 复用 vite 的 `@` → `./src` alias（测试里也常 import `@/lib/...`）
 *   - environment 用 jsdom：`@tiptap/core` 的 generateHTML/generateJSON 依赖 DOM；
 *     contentFormat 测试会触达这条链路
 *   - include 限定到 __tests__ 目录，避免把运行时代码里含 `.test.` 的文件误判
 */
import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/__tests__/**/*.{test,spec}.{ts,tsx}"],
    // 切换相关测试都是纯计算 / DOM，单跑 < 2s 足够
    testTimeout: 10_000,
  },
});
