import { test, expect } from "@playwright/test";

test.use({
  browserName: "webkit",
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      Object.defineProperty(Promise.prototype, "finally", {
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(Array.prototype, "findLast", {
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(Array.prototype, "findLastIndex", {
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.assign(window, { queueMicrotask: undefined });
    } catch {
      // The test still exercises WebKit cold-start even if a runtime refuses monkey-patching.
    }
  });
});

test("iPhone WebKit cold start removes the boot splash", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });

  await expect(page.locator("#root form, #root main, #root [data-unified-sidebar]").first())
    .toBeVisible({ timeout: 12_000 });
  await expect(page.locator("#app-boot-splash")).toHaveCount(0, { timeout: 12_000 });
  expect(pageErrors).toEqual([]);
});

test("historical localStorage does not trap WebKit on the splash", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("nowen-note-skin", "macos");
    localStorage.setItem("nowen-note-theme", "dark");
    localStorage.setItem("nowen-note-workspace-layout", "three-column");
  });

  await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });

  await expect(page.locator("#root form, #root main, #root [data-unified-sidebar]").first())
    .toBeVisible({ timeout: 12_000 });
  await expect(page.locator("#app-boot-splash")).toHaveCount(0, { timeout: 12_000 });
});
