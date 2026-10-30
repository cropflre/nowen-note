import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";
export default defineConfig({
  testDir: "./e2e", testMatch: "markdown-slash-menu.spec.ts", workers: 1, timeout: 60000,
  outputDir: path.join(os.tmpdir(), "nowen-853-browser-artifacts"), reporter: "list",
  use: { headless: true, channel: process.env.PLAYWRIGHT_CHANNEL, hasTouch: true, screenshot: "only-on-failure", actionTimeout: 10000 },
});
