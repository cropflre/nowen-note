import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: ["smart-import.spec.ts"], workers: 1, timeout: 240000,
  outputDir: "node_modules/.cache/smart-import-results",
  use: { channel: process.env.NOWEN_QA_BROWSER_CHANNEL || undefined, viewport: { width: 1440, height: 960 }, actionTimeout: 15000 },
});
