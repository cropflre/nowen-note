import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", testMatch: "daily-records-calendar.spec.ts", workers: 1, timeout: 60000,
  outputDir: "../docs/qa/artifacts/daily-records-calendar", reporter: "list",
  use: {
    headless: true, channel: process.env.PLAYWRIGHT_CHANNEL,
    locale: "zh-CN", timezoneId: "Asia/Shanghai", isMobile: true, hasTouch: true,
    viewport: { width: 1440, height: 960 }, screenshot: "only-on-failure", actionTimeout: 10000,
  },
});
