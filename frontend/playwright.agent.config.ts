import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./e2e", testMatch: "agent.spec.ts", workers: 1, timeout: 90000, outputDir: "../docs/qa/artifacts/agent", reporter: "list", use: { headless: true, channel: process.env.PLAYWRIGHT_CHANNEL, screenshot: "only-on-failure", actionTimeout: 15000 } });
