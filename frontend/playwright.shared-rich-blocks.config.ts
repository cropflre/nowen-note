import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

// Run `npx vite build` first: the spec serves frontend/dist from a disposable backend.
export default defineConfig({
  testDir: "./e2e", testMatch: "shared-rich-blocks.spec.ts", workers: 1, timeout: 120000,
  outputDir: path.join(os.tmpdir(), "nowen-shared-rich-blocks-artifacts"), reporter: "list",
  use: { headless: true, channel: process.env.PLAYWRIGHT_CHANNEL, locale: "en-US", screenshot: "only-on-failure", actionTimeout: 15000 },
});
