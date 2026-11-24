import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: ["ai-memory-switch.spec.ts", "ai-memory-mcp.spec.ts", "ai-memory-import.spec.ts"], workers: 1, timeout: 180000,
  outputDir: "node_modules/.cache/ai-memory-switch-results",
  use: { channel: process.env.NOWEN_QA_BROWSER_CHANNEL || undefined, viewport: { width: 1440, height: 960 }, actionTimeout: 15000 },
});
