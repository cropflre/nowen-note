import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

// Run `npx vite build` first: the alias that replaces the command palette only exists in real builds.
export default defineConfig({
  testDir: "./e2e", testMatch: "shortcut-runtime.spec.ts", workers: 1, timeout: 180000,
  outputDir: path.join(os.tmpdir(), "nowen-shortcut-runtime-artifacts"), reporter: "list",
  use: { headless: true, channel: process.env.PLAYWRIGHT_CHANNEL, viewport: { width: 1440, height: 960 }, locale: "en-US", screenshot: "only-on-failure", actionTimeout: 15000 },
});
