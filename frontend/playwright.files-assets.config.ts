import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", testMatch: /files-assets-(center|organization|reliability|visual-tools|ai)\.spec\.ts/, workers: 1, timeout: 120_000,
  outputDir: "node_modules/.cache/files-assets-results",
  use: { baseURL: "http://127.0.0.1:4197", channel: process.env.NOWEN_QA_BROWSER_CHANNEL || undefined, viewport: { width: 1600, height: 950 }, actionTimeout: 10_000 },
  webServer: { command: "node ../scripts/run-files-assets-qa-server.mjs", url: "http://127.0.0.1:4197/api/version", reuseExistingServer: false, timeout: 60_000 },
});
