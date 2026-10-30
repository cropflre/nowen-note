import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "plaintext-notes.spec.ts", workers: 1, timeout: 60000,
  outputDir: "../docs/qa/artifacts/plaintext-notes", reporter: "list",
  use: { headless: true, channel: process.env.PLAYWRIGHT_CHANNEL, screenshot: "only-on-failure", actionTimeout: 10000 },
});
