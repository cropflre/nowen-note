import { expect, test, type Page } from "@playwright/test";

const bitmap = (page: Page) => page.locator("[data-nowen-image-viewer-image]");
const preview = (page: Page) => page.locator("[data-nowen-fullscreen-image-viewer]");
const matrix = (page: Page) => bitmap(page).evaluate(img => {
  const m = new DOMMatrix(getComputedStyle(img.parentElement!).transform);
  return { x: m.m41, y: m.m42, scale: Math.hypot(m.m11, m.m12) };
});
test.beforeEach(async ({ page }) => {
  await page.route("**/api/attachments/**", async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("media") === "info") return route.fulfill({ json: { kind: "static", hasMotion: false } });
    const portrait = url.pathname.endsWith("216");
    const width = Number(url.searchParams.get("w")) || (portrait ? 1200 : 2400);
    const height = portrait ? width * 2 : width / 2;
    return route.fulfill({ contentType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="white"/></pattern></defs><path fill="#326080" d="M0 0h${width}v${height}H0z"/><path fill="url(#grid)" d="M0 0h${width}v${height}H0z"/><circle cx="${width / 2}" cy="${height / 2}" r="80" fill="#f6bf60"/></svg>` });
  });
  await page.goto("/e2e/image-preview.html");
});
async function open(page: Page, single = false) {
  await page.getByRole("button", { name: single ? "Open single" : "Open gallery", exact: true }).click();
  await expect(bitmap(page)).toBeVisible();
  await expect.poll(() => bitmap(page).evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(1200);
  await expect(preview(page)).toHaveCSS("opacity", "1");
}

test("original resolution, aspect ratio and accurate 1:1", async ({ page }, testInfo) => {
  await open(page);
  const src = new URL(await bitmap(page).getAttribute("src") || "");
  expect(src.searchParams.has("w")).toBe(false);
  expect(src.searchParams.get("sig")).toBe("fixture");
  await expect(preview(page)).toHaveAttribute("data-swipe-blocker", "image-viewer");
  if (testInfo.project.name === "mobile") await page.getByRole("button", { name: "更多图片操作" }).click();
  await page.getByRole("button", { name: "下载图片", exact: true }).click();
  await expect.poll(async () => new URL((await page.getByTestId("download-source").textContent())!).searchParams.has("w")).toBe(false);
  expect(await bitmap(page).evaluate(img => (img as HTMLImageElement).clientWidth / (img as HTMLImageElement).clientHeight)).toBeCloseTo(0.5, 2);
  await page.getByRole("button", { name: "在适应窗口和原始比例之间切换" }).click();
  await expect(page.getByRole("button", { name: "在适应窗口和原始比例之间切换" })).toHaveText("100%");
  await expect(page.getByText("已超过原图分辨率，图片可能变模糊")).toBeVisible();
  await page.getByRole("button", { name: "顺时针旋转图片" }).click();
  await expect.poll(() => bitmap(page).evaluate(img => {
    const rect = img.getBoundingClientRect(); return rect.width / rect.height;
  })).toBeCloseTo(2, 1);
  await page.screenshot({ path: testInfo.outputPath("rotated-original.png") });
});

test("editor preserves decoded ratio, saved width, rotation and flip", async ({ page }) => {
  const img = page.locator(".resizable-image-wrapper img");
  await expect.poll(() => img.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBe(240);
  await expect.poll(() => img.evaluate(img => img.getBoundingClientRect().width / img.getBoundingClientRect().height)).toBeCloseTo(2, 2);
  await img.click();
  await expect(page.getByText("当前图片分辨率不足，可能模糊", { exact: true })).toBeVisible();
  const width = await img.getAttribute("width");
  await page.getByRole("button", { name: "向右旋转 90°" }).click();
  await page.getByRole("button", { name: "水平翻转" }).click();
  await expect.poll(() => img.evaluate(img => img.getBoundingClientRect().width / img.getBoundingClientRect().height)).toBeCloseTo(0.5, 2);
  await page.setViewportSize({ width: 360, height: 780 });
  await expect.poll(() => img.evaluate(img => img.getBoundingClientRect().width / img.getBoundingClientRect().height)).toBeCloseTo(0.5, 2);
  expect(await img.getAttribute("width")).toBe(width);
  await expect(img).toHaveCSS("transform", /matrix/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("real touch swipes, pinches and continues panning without page scroll", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Requires Chromium touch emulation");
  await open(page);
  const cdp = await context.newCDPSession(page);
  const touch = async (type: string, points: Array<{ x: number; y: number; id: number }>) => {
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  };
  const swipe = async (start: number, end: number) => {
    await touch("touchStart", [{ x: start, y: 350, id: 1 }]);
    await touch("touchMove", [{ x: end, y: 350, id: 1 }]);
    await touch("touchEnd", []);
  };
  await swipe(280, 100);
  await expect(bitmap(page)).toHaveAttribute("alt", "Landscape");
  await swipe(280, 100);
  await expect(bitmap(page)).toHaveAttribute("alt", "Landscape");
  await swipe(100, 280);
  await expect(bitmap(page)).toHaveAttribute("alt", "Portrait");
  await expect.poll(() => bitmap(page).evaluate(img => (img as HTMLImageElement).naturalHeight)).toBe(2400);
  await touch("touchStart", [{ x: 130, y: 350, id: 1 }, { x: 230, y: 350, id: 2 }]);
  await touch("touchMove", [{ x: 80, y: 350, id: 1 }, { x: 280, y: 350, id: 2 }]);
  await expect.poll(async () => (await matrix(page)).scale).toBeCloseTo(2, 1);
  await touch("touchEnd", [{ x: 280, y: 350, id: 2 }]);
  const before = await matrix(page);
  await touch("touchMove", [{ x: 120, y: 400, id: 1 }]);
  await touch("touchEnd", []);
  await expect.poll(async () => (await matrix(page)).x).toBeCloseTo(before.x + 40, 0);
  await expect.poll(async () => (await matrix(page)).y).toBeCloseTo(before.y + 50, 0);
  await expect(bitmap(page)).toHaveAttribute("alt", "Portrait");
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByRole("button", { name: "复原图片预览" }).click();
  await page.getByRole("button", { name: "在适应窗口和原始比例之间切换" }).click();
  await expect(page.getByRole("button", { name: "在适应窗口和原始比例之间切换" })).toHaveText("100%");
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  await expect(preview(page)).not.toBeVisible();
  await open(page, true);
  await swipe(280, 100);
  await expect(bitmap(page)).toHaveAttribute("alt", "Portrait");
  await expect(preview(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("touch-single.png") });
});
