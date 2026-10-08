import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import browser from "./playwright.encrypted-notes.config";

process.env.NOWEN_ENCRYPTED_ELECTRON = "1";
export default defineConfig({
  ...browser,
  testMatch: [...browser.testMatch as string[], "encrypted-notes-electron.spec.ts"],
  outputDir: "node_modules/.cache/encrypted-notes-electron-results",
  webServer: [{
    command: "../node_modules/.bin/electron --import tsx tests/encrypted-notes-browser-server.ts",
    cwd: fileURLToPath(new URL("../backend", import.meta.url)),
    env: { ELECTRON_RUN_AS_NODE: "1" },
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
