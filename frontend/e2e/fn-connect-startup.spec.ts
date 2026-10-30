import { test, expect } from "@playwright/test";

test.use({
  browserName: "chromium",
  userAgent: "Mozilla/5.0 (Linux; Android 15; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/153.0.8010.57 Mobile Safari/537.36 FNOS/1.2.0605 FNAppType/Android FNAppVer/1.37.1",
  viewport: { width: 393, height: 852 },
  isMobile: true,
  hasTouch: true,
});

test("slow gateway modules keep loading and automatically reveal login", async ({ page }) => {
  await page.clock.install();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/assets/index-*.js", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("http://127.0.0.1:4173/", { waitUntil: "commit" });
    await expect(page.locator("#app-boot-splash")).toHaveCount(1);
    await page.clock.runFor(12_100);
    await expect(page.locator(".app-boot-title")).toHaveText(/仍在加载|Still loading/);
    await expect(page.locator(".app-boot-spinner")).toBeVisible();
    await expect(page.locator("#app-boot-copy")).toBeVisible();
    release();
    await expect(page.locator("#root form").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#app-boot-splash")).toHaveCount(0);
    expect(await page.evaluate(() => (window as Window & { __NOWEN_BOOT_DIAGNOSTICS__: { stage: string } }).__NOWEN_BOOT_DIAGNOSTICS__.stage)).toBe("ready");
  } finally {
    release();
  }
});

test("a failed module still exposes a real startup error", async ({ page }) => {
  await page.route("**/assets/index-*.js", (route) => route.abort("failed"));
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app-boot-code")).toContainText("BOOT_RUNTIME_ERROR");
});
