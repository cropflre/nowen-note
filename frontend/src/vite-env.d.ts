/// <reference types="vite/client" />

// vite.config.ts 在构建时通过 `define` 把根 package.json 的 version
// 注入为一个全局常量，用于 UI 展示（例如设置面板底部的版本号）。
declare const __APP_VERSION__: string;

// 体验环境开关（仅线上 demo 站点构建时设置，自部署用户不传 = 完全不启用）。
//   构建命令：`VITE_DEMO_MODE=true npm run build`
//   作用：登录页显示「体验账号」提示条 + 一键填入按钮。
// 不影响后端、不影响任何已有逻辑——只是 UI 多渲染两个元素。
interface ImportMetaEnv {
  readonly VITE_DEMO_MODE?: string;
  readonly VITE_DEMO_USERNAME?: string;
  readonly VITE_DEMO_PASSWORD?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  __NOWEN_EDITOR_PERF__?: import("./lib/editorPerformanceHarness").EditorPerformanceGlobalEntry;
}
