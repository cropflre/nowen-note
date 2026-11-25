import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

// Issue #915: run `npx vite build` first; the spec serves frontend/dist from a disposable backend.
export default defineConfig({
  testDir: "./e2e", testMatch: "rich-text-issue-915.spec.ts", workers: 1, timeout: 180000,
  outputDir: path.join(os.tmpdir(), "nowen-915-browser-artifacts"), reporter: "list",
  use: { headless: true, channel: process.env.PLAYWRIGHT_CHANNEL, viewport: { width: 1440, height: 960 }, locale: "en-US", screenshot: "only-on-failure", actionTimeout: 15000 },
});
