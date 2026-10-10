import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "xlsx-preview.spec.ts",
  outputDir: "node_modules/.cache/xlsx-preview-results",
  use: { baseURL: "http://127.0.0.1:5189", browserName: "chromium", locale: "zh-CN" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: "npx vite --host 127.0.0.1 --port 5189 --strictPort", url: "http://127.0.0.1:5189/e2e/xlsx-preview.html", reuseExistingServer: false },
});
