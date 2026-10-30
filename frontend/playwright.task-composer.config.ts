import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "task-composer.spec.ts", workers: 1, timeout: 60000,
  outputDir: "../docs/qa/artifacts/task-composer", reporter: "list",
  use: { headless: true, channel: process.env.PLAYWRIGHT_CHANNEL, timezoneId: "Asia/Shanghai", screenshot: "only-on-failure", actionTimeout: 10000 },
});
