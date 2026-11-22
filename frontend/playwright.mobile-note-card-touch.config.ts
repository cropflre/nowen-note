import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

// Run `npx vite build` first: the lazy command palette alias that hid this guard only exists in real builds.
export default defineConfig({
  testDir: "./e2e", testMatch: "mobile-note-card-touch.spec.ts", workers: 1, timeout: 120000,
  outputDir: path.join(os.tmpdir(), "nowen-mobile-touch-artifacts"), reporter: "list",
  use: { headless: true, channel: process.env.PLAYWRIGHT_CHANNEL, locale: "en-US", screenshot: "only-on-failure", actionTimeout: 15000 },
});
