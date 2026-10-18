import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "plugin-apps.spec.ts", workers: 1, timeout: 120000,
  outputDir: "node_modules/.cache/plugin-app-results",
  use: { channel: process.env.NOWEN_QA_BROWSER_CHANNEL || undefined, viewport: { width: 1440, height: 960 }, actionTimeout: 15000 },
});
