import path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import appConfig from "./vite.config";
export default mergeConfig(appConfig, defineConfig({ build: { rollupOptions: { input: {
  app: path.resolve(__dirname, "index.html"),
  acceptance: path.resolve(__dirname, "tests/android-sync/index.html"),
} } } }));
