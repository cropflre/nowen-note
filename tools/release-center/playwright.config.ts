import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "*.spec.ts",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4328",
    browserName: "chromium",
    viewport: { width: 1440, height: 1040 },
  },
  webServer: {
    command: "node --import tsx tests/browser/server.ts",
    url: "http://127.0.0.1:4328",
    reuseExistingServer: false,
    timeout: 30000,
  },
  outputDir: "test-results",
});
