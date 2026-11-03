import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "image-preview.spec.ts",
  outputDir: "node_modules/.cache/image-preview-results",
  use: { baseURL: "http://127.0.0.1:5192", browserName: "chromium", locale: "zh-CN" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
  ],
  webServer: { command: "npx vite --host 127.0.0.1 --port 5192 --strictPort", url: "http://127.0.0.1:5192/e2e/image-preview.html", reuseExistingServer: false },
});
