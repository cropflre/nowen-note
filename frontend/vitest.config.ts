/**
 * Vitest 配置（T1：编辑器切换关键路径的单元测试基础设施）
 *
 * 设计要点：
 *   - 精确 Runtime Shell 别名必须排在通用 `@` 别名前，和生产 Vite 配置保持一致；
 *   - environment 用 jsdom：`@tiptap/core` 的 generateHTML/generateJSON 依赖 DOM；
 *   - include 限定到 __tests__ 目录，避免把运行时代码里含 `.test.` 的文件误判。
 */
import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@\/components\/VideoExtension$/,
        replacement: path.resolve(__dirname, "./src/components/VideoExtensionRuntime.tsx"),
      },
      {
        find: /^@\/components\/MermaidView$/,
        replacement: path.resolve(__dirname, "./src/components/MermaidViewRuntime.tsx"),
      },
      {
        find: /^@\/components\/MathExtensions$/,
        replacement: path.resolve(__dirname, "./src/components/MathExtensionsRuntime.tsx"),
      },
      {
        find: /^@\/components\/SearchReplacePanel$/,
        replacement: path.resolve(__dirname, "./src/components/SearchReplacePanelRuntime.tsx"),
      },
      {
        find: /^@\/components\/TiptapEditor$/,
        replacement: path.resolve(__dirname, "./src/components/TiptapEditorRuntime.tsx"),
      },
      {
        find: /^@\/lib\/proseMirrorPlainText$/,
        replacement: path.resolve(__dirname, "./src/lib/proseMirrorPlainTextRuntime.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/__tests__/**/*.{test,spec}.{ts,tsx}"],
    // 切换相关测试都是纯计算 / DOM，单跑 < 2s 足够
    testTimeout: 10_000,
  },
});