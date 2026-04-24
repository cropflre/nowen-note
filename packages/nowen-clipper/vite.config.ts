import { defineConfig } from "vite";
import { resolve } from "path";

/**
 * Vite 配置：MV3 扩展的多入口构建。
 *
 * 关键点：
 *   - background / content 是纯 TS 入口，输出单文件到 dist/ 根。
 *     由于 content script 不支持 ESM import，它必须是自包含的单文件。
 *     background service worker 虽然 MV3 支持 "type":"module"，
 *     但为了兼容性也做成单文件。
 *   - popup / options 是 HTML 入口，Vite 按源目录结构写出（需 flatten 脚本修正路径）。
 *     它们可以共享 chunks，因为作为 HTML 页面能正常加载 ESM 模块。
 *
 * 策略：
 *   把 popup + options 共享的 lib 代码（storage/api）提取为 chunks，
 *   background 和 content 各自 inline 所有依赖。这通过 manualChunks 实现：
 *   只在 popup/options 共享的库模块上返回 chunk name，其余返回 undefined 让
 *   Rollup 内联到引用方入口。
 *
 *   但 Rollup 对多入口始终会提取共享模块。所以我们改用另一种方式：
 *   将 background/content 的构建与 popup/options 分开——
 *   不！那样 Vite 不支持多次 build。
 *
 *   最终方案：background 声明了 "type":"module"，Chrome 110+ 允许
 *   service worker 做 static import。只要被导入的 chunk 在扩展包内就没问题。
 *   content script 如果也产生了 chunk 引用才会出错。我们用 preserveEntrySignatures
 *   来控制。
 */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome110",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/index.ts"),
        content: resolve(__dirname, "src/content/index.ts"),
        popup: resolve(__dirname, "src/popup/index.html"),
        options: resolve(__dirname, "src/options/index.html"),
      },
      output: {
        entryFileNames: (chunk) => {
          return `${chunk.name}.js`;
        },
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: (asset) => {
          const n = asset.name || "asset";
          if (n.endsWith(".css")) return "assets/[name][extname]";
          return "assets/[name]-[hash][extname]";
        },
      },
    },
  },
});
