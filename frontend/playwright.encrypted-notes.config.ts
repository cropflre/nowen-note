import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["encrypted-notes-core.spec.ts", "encrypted-notes-v2.spec.ts", "encrypted-notes-editor.spec.ts", "encrypted-notes-blocks.spec.ts", "encrypted-notes-product-editor.spec.ts", "encrypted-notes-cleanup.spec.ts"],
  workers: 1,
  timeout: 60_000,
  outputDir: "node_modules/.cache/encrypted-notes-browser-results",
  use: { browserName: "chromium", baseURL: "http://127.0.0.1:5176" },
  webServer: [{
    command: "../backend/node_modules/.bin/tsx ../backend/tests/encrypted-notes-browser-server.ts",
    url: "http://127.0.0.1:5177/api/health",
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  }, {
    command: "npm run preview:encrypted-notes-benchmark",
    url: "http://127.0.0.1:5176/benchmarks/encrypted-notes.html",
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  }],
});
