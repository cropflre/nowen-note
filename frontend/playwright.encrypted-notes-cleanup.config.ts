import { defineConfig } from "@playwright/test";

// No backend is needed: this stage verifies post-commit local storage primitives.
export default defineConfig({
  testDir: "./e2e", testMatch: "encrypted-notes-cleanup.spec.ts", workers: 1, timeout: 30_000,
  outputDir: "node_modules/.cache/encrypted-notes-cleanup-results",
  use: { browserName: "chromium" },
  webServer: {
    command: "npm run preview:encrypted-notes-benchmark", url: "http://127.0.0.1:5176/benchmarks/encrypted-notes-cleanup.html", reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
