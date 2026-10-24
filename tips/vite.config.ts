import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Nowen Note Tips —— 开发配置
 *
 * 关键点：`/api` 走 dev 代理转发到 Nowen 服务端。
 * 这样浏览器看到的是【同源】请求，**完全不需要改服务端的 CORS_ORIGINS**
 * （生产容器一行都不用动）。
 *
 * 用 npm run dev -- --host 0.0.0.0 可以让手机在同一局域网里直接访问测试。
 */
const BACKEND = process.env.NOWEN_LITE_BACKEND || "http://127.0.0.1:3002";

export default defineConfig({
  plugins: [react()],
  // ⚠️ 必须是相对路径：桌面壳（Electron）用 file:// 加载产物，
  //    绝对路径 /assets/… 会解析到文件系统根目录 → 白屏。
  //    相对路径对三个壳都成立（file:// 同目录、Capacitor 的
  //    https://localhost/、WinUI 的虚拟主机解析结果一致）。
  base: "./",
  server: {
    host: "0.0.0.0",
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": {
        target: BACKEND,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5175,
    strictPort: true,
  },
  build: {
    // 目标就是小体积：单独把 vendor 拆出来，方便看谁胖
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
        },
      },
    },
  },
});
