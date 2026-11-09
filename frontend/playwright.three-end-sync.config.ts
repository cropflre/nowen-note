import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "three-end-sync.spec.ts",
  workers: 1,
  timeout: 180000,
  outputDir: path.join(os.tmpdir(), "nowen-three-end-artifacts"),
  reporter: "list",
  use: {
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    screenshot: "only-on-failure",
    actionTimeout: 15000,
  },
});
