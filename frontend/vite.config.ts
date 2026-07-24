import path from "path"
import fs from "node:fs"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// 读取根 package.json 的 version，注入到前端以便 UI 展示真实版本号
// （release.sh 会在发布时更新根 package.json 的 version 字段）
const rootPkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf-8"),
) as { version?: string }
const APP_VERSION = rootPkg.version || "0.0.0"

export default defineConfig({
  // Electron 远端/API-only 模式会直接加载打包后的 frontend/dist/index.html。
  // 使用相对 base，确保 file:// 下 /assets 不会解析到磁盘根目录。
  base: "./",
  root: path.resolve(__dirname),
  plugins: [react()],
  define: {
    // 编译期常量；使用 JSON.stringify 确保是带引号的字符串字面量
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  resolve: {
    alias: [
      // Issue #218：只替换 App / SettingsModal 使用的绝对导入。
      // 壳组件内部通过相对路径导入原组件，因此不会发生递归别名。
      {
        find: /^@\/components\/AIChatPanel$/,
        replacement: path.resolve(__dirname, "./src/components/AIChatReliabilityShell.tsx"),
      },
      {
        find: /^@\/components\/AISettingsPanel$/,
        replacement: path.resolve(__dirname, "./src/components/AISettingsReliabilityShell.tsx"),
      },
      // Issue #369：保留原 schema / serializer，仅替换高成本媒体 NodeView、公式与全文搜索壳。
      // Runtime 壳内部使用相对路径导入原组件，避免精确别名递归。
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
      // Issue #369：统一监听 Markdown / Tiptap 首次可交互，普通模式超时后自动降级。
      // 初始化壳再通过相对路径进入原运行时，避免精确别名递归。
      {
        find: /^@\/components\/MarkdownEditor$/,
        replacement: path.resolve(__dirname, "./src/components/MarkdownEditorInitializationRuntime.tsx"),
      },
      {
        find: /^@\/components\/TiptapEditor$/,
        replacement: path.resolve(__dirname, "./src/components/TiptapEditorInitializationRuntime.tsx"),
      },
      // Issue #369：Tiptap 派生数据只扫描一次；优化模式暂停实时全文大纲。
      {
        find: /^@\/lib\/proseMirrorPlainText$/,
        replacement: path.resolve(__dirname, "./src/lib/proseMirrorPlainTextRuntime.ts"),
      },
      // Issue #369：大 Markdown 使用 CodeMirror transaction ↔ Y.Text delta 增量同步。
      // 原组件和纯策略通过相对路径保留，Runtime 壳只接管协作热路径。
      {
        find: /^@\/components\/LargeMarkdownSafeEditor$/,
        replacement: path.resolve(__dirname, "./src/components/LargeMarkdownSafeEditorRuntime.tsx"),
      },
      {
        find: /^@\/lib\/largeMarkdownSafety$/,
        replacement: path.resolve(__dirname, "./src/lib/largeMarkdownSafetyRuntime.ts"),
      },
      // Issue #369 P2：在不侵入 EditorPane 主体的前提下增加事务化文档拆分入口。
      {
        find: /^@\/components\/EditorPane$/,
        replacement: path.resolve(__dirname, "./src/components/EditorPaneRuntime.tsx"),
      },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
  optimizeDeps: {
    esbuildOptions: {
      keepNames: true,
    },
  },
  // Keep worker output compatible with the Chrome 64 / older Android WebView build target.
  worker: {
    format: "iife",
  },
  build: {
    target: "chrome64",
    cssTarget: "chrome64",
    sourcemap: false,
    // 禁用 modulePreload polyfill 注入，避免某些 rollup 版本将
    // "vite/modulepreload-polyfill" 误识别为 source phase import 而报错。
    // 现代浏览器（Chrome 64+、Firefox 115+、Safari 17.5+）已原生支持 modulepreload，
    // Capacitor WebView 和 Electron 同样无需 polyfill。
    modulePreload: { polyfill: false },
    // 降低 chunk 大小警告阈值
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // 手动分包，降低构建内存峰值
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-tiptap': [
            '@tiptap/react',
            '@tiptap/starter-kit',
            '@tiptap/extension-code-block-lowlight',
            '@tiptap/extension-highlight',
            '@tiptap/extension-image',
            '@tiptap/extension-placeholder',
            '@tiptap/extension-task-item',
            '@tiptap/extension-task-list',
            '@tiptap/extension-underline',
          ],
          'vendor-lib': [
            'framer-motion',
            'lucide-react',
            'react-icons',
            'jszip',
            'react-markdown',
            'remark-gfm',
            'turndown',
            'date-fns',
            'i18next',
            'react-i18next',
          ],
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    // 接受来自手机 App（Capacitor WebView）跨 origin 的 HMR WebSocket 握手。
    // 手机侧的 `capacitor.config.ts#server.url` 会把 WebView 直接指向
    // `http://<电脑LAN_IP>:5173`，此时 host 就是 LAN IP。
    // 不设 hmr.host 时 vite 会把 HMR clientScript 固定成某个值（通常是 localhost），
    // 导致手机端无法命中 HMR 通道——因此显式放开。
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      // 后端的实时协作 WebSocket（Y.js presence / 协同编辑）也必须代理，
      // 否则手机端 `new WebSocket("/ws")` 会落到 vite 自己的 HMR server 上。
      "/ws": {
        target: "ws://localhost:3001",
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
