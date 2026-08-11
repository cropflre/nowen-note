import { defineConfig, type UserConfig } from "vite"
import baseConfig from "./vite.config"

const config = baseConfig as UserConfig
const backendUrl = process.env.NOWEN_DEV_BACKEND_URL?.trim() || "http://127.0.0.1:3001"
const backendWsUrl = backendUrl
  .replace(/^http:/, "ws:")
  .replace(/^https:/, "wss:")

export default defineConfig({
  ...config,
  server: {
    ...config.server,
    proxy: {
      ...config.server?.proxy,
      "/api": {
        target: backendUrl,
        changeOrigin: true,
      },
      "/ws": {
        target: backendWsUrl,
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
