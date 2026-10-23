import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "knowledge-tree-drag.spec.ts", workers: 1, timeout: 60000,
  outputDir: "../docs/qa/artifacts/knowledge-tree-drag", reporter: "list",
  use: { headless: true, screenshot: "only-on-failure", actionTimeout: 10000 },
});
