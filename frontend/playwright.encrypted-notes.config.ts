import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "encrypted-notes-core.spec.ts",
  workers: 1,
  timeout: 60_000,
  outputDir: "node_modules/.cache/encrypted-notes-browser-results",
  use: { browserName: "chromium", baseURL: "http://127.0.0.1:5176" },
  webServer: {
    command: "npm run preview:encrypted-notes-benchmark",
    url: "http://127.0.0.1:5176/benchmarks/encrypted-notes.html",
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
