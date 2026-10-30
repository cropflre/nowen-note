import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /(mobile-layout|ai-collaboration)\.spec\.ts/,
  workers: 1,
  timeout: 45_000,
  outputDir: "node_modules/.cache/mobile-layout-results",
  use: { baseURL: "http://127.0.0.1:4197", actionTimeout: 10_000 },
  webServer: {
    command: "node ../scripts/run-files-assets-qa-server.mjs",
    url: "http://127.0.0.1:4197/api/version",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
