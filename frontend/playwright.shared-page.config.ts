import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "shared-page-loading.spec.ts",
  workers: 1,
  timeout: 60_000,
  outputDir: "node_modules/.cache/shared-page-results",
  use: { browserName: "chromium", baseURL: "http://127.0.0.1:5193" },
  webServer: {
    command: "npm exec vite preview -- --host 127.0.0.1 --port 5193 --strictPort",
    url: "http://127.0.0.1:5193",
    reuseExistingServer: false,
  },
});
