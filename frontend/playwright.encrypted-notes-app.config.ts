import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", testMatch: "encrypted-notes-app.spec.ts",
  workers: 1, timeout: 90_000,
  outputDir: "node_modules/.cache/encrypted-notes-app-results",
});
