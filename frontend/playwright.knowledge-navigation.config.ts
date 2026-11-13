import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /(knowledge-navigation|sidebar-search-style)\.spec\.ts/,
  workers: 1,
  timeout: 90_000,
  outputDir: path.join(os.tmpdir(), "nowen-knowledge-navigation-playwright"),
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4197",
    viewport: { width: 1600, height: 1000 },
    headless: true,
    actionTimeout: 10_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node ../scripts/run-files-assets-qa-server.mjs",
    url: "http://127.0.0.1:4197/api/version",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
