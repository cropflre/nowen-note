import { test, expect } from "@playwright/test";

// Only the local fixture server is used. No publication credentials or remote writes.
test("formal release page and API fail closed before publication approval", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/#formal");
  await expect(page.getByRole("heading", { name: "接管已有正式构建" })).toBeVisible();
  const candidateWorkflow = page.getByRole("link", { name: /在 GitHub Actions 打开独立候选构建/ });
  await expect(candidateWorkflow).toHaveAttribute("href", "https://github.com/cropflre/nowen-note/actions/workflows/release-center-candidate.yml");
  await expect(page.getByText("候选包 · 不可直接发布")).toBeVisible();
  await expect(page.getByText("尚无正式候选。已完成的调试验收不会自动出现在这里。")).toBeVisible();

  const before = await page.request.get("/api/publication");
  expect(before.status()).toBe(200);
  const initial = await before.json();
  expect(initial.draftsEnabled).toBe(false);
  expect(initial.publishEnabled).toBe(false);
  expect(initial.candidates).toEqual([]);

  const invalid = { version: "1.5.2", runId: 71, notes: "Browser test fixture", key: "fixture-formal-key-0001" };
  const missingOriginMarker = await page.request.post("/api/publication/import", { data: invalid });
  expect(missingOriginMarker.status()).toBe(403);
  const extraField = await page.request.post("/api/publication/import", {
    headers: { "X-Release-Center": "1" },
    data: { ...invalid, command: "git push" },
  });
  expect(extraField.status()).toBe(400);

  await page.getByLabel("正式版本（X.Y.Z）").fill("1.5.2");
  await page.getByLabel("正式 Actions Run ID").fill("71");
  await page.getByLabel("正式发布说明").fill("Fixture-only negative import check");
  await page.getByRole("button", { name: "接管并下载复核" }).click();
  await expect(page.getByRole("alert")).toContainText("无效的正式构建来源");
  const after = await page.request.get("/api/publication");
  expect((await after.json()).candidates).toEqual([]);
  expect(errors).toEqual([]);
});

test("formal release page stays readable on a narrow dark layout without enabling publishing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#formal");
  await page.getByRole("button", { name: "切换暗色模式" }).click();
  await expect(page.locator("html")).toHaveClass("dark");
  await expect(page.getByText("正式写操作默认关闭。", { exact: false })).toBeVisible();
  const status = await page.request.get("/api/publication");
  expect(status.status()).toBe(200);
  expect((await status.json()).publishEnabled).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
