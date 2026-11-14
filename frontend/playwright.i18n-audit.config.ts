import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "i18n-audit.spec.ts",
  workers: 1,
  timeout: 60_000,
  outputDir: path.join(os.tmpdir(), "nowen-i18n-audit-playwright"),
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4197", headless: true, actionTimeout: 10_000, screenshot: "only-on-failure" },
  webServer: {
    command: "node ../scripts/run-files-assets-qa-server.mjs",
    url: "http://127.0.0.1:4197/api/version",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
