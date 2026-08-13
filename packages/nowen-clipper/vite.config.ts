import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";

/**
 * Manifest V3 的 content_scripts 与 scripting.executeScript(files) 都按经典脚本执行。
 * 一旦 Rollup 把共享依赖拆成 import，content.js 会在 listener 注册前直接语法失败。
 */
function assertStandaloneContentScript(): Plugin {
  return {
    name: "assert-standalone-content-script",
    generateBundle(_options, bundle) {
      const content = bundle["content.js"];
      if (!content || content.type !== "chunk") return;
      if (content.imports.length > 0 || content.dynamicImports.length > 0) {
        this.error(`content.js 必须是可直接注入的单文件，禁止依赖其他 chunk：${[
          ...content.imports,
          ...content.dynamicImports,
        ].join(", ")}`);
      }
    },
  };
}

/**
 * Vite 配置：MV3 扩展的多入口构建。
 *
 * enhanced.ts 会先加载原 background/index.ts，保留右键菜单、快捷键和截图能力，
 * 再挂载 Issue #217 的统一速记/剪藏流水线。
 */
export default defineConfig({
  plugins: [assertStandaloneContentScript()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome110",
    minify: false,
    sourcemap: false,
    commonjsOptions: {
      include: [/node_modules/],
    },
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/enhanced.ts"),
        content: resolve(__dirname, "src/content/index.ts"),
        popup: resolve(__dirname, "src/popup/index.html"),
        options: resolve(__dirname, "src/options/index.html"),
      },
      output: {
        entryFileNames: (chunk) => `${chunk.name}.js`,
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
