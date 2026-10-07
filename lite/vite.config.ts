import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Nowen Note Lite —— 开发配置
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
