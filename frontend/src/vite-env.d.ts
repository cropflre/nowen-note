/// <reference types="vite/client" />

// vite.config.ts 在构建时通过 `define` 把根 package.json 的 version
// 注入为一个全局常量，用于 UI 展示（例如设置面板底部的版本号）。
declare const __APP_VERSION__: string;
