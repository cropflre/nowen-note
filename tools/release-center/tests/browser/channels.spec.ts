import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const screenshot = (name: string) => fileURLToPath(new URL(`../../docs/screenshots/${name}.jpg`, import.meta.url));
test("channels expose real service states, immutable JSON handoff and explicitly unverified receipts", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#channels");
  await expect(page.getByText("尚未查询", { exact: true })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "执行分发（待正式审批）" })).toBeDisabled();
  await page.getByRole("button", { name: "查询渠道", exact: true }).click();
  await expect(page.getByText("Partner Center：Certification", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("观察到版本 Tag 与 manifest digest", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "生成 / 恢复计划", exact: true }).click();
  await expect(page.getByRole("heading", { name: "v1.5.2 · 交接计划", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "生成 / 恢复计划", exact: true }).click();
  await expect(page.getByRole("heading", { name: "v1.5.2 · 交接计划", exact: true })).toHaveCount(1);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出交接 JSON", exact: true }).click();
  const download = await downloadPromise;
  const contents = await readFile((await download.path())!, "utf8");
  const plan = JSON.parse(contents);
  expect(plan.purpose).toBe("distribution-handoff-only");
  expect(plan.executable).toBe(false);
  expect(plan.approval).toBe("not_connected");
  expect(plan.source.sha).toBe("c".repeat(40));
  expect(contents).not.toMatch(/fixture-partner-center-credential|ghp_|fileUploadUrl|must-not-leak/);
  await page.getByText("记录已有平台回执", { exact: true }).click();
  const save = page.getByRole("button", { name: "保存人工记录", exact: true });
  await expect(save).toBeDisabled();
  await page.getByLabel("平台回执编号", { exact: true }).fill("browser-fixture-ticket");
  await page.getByLabel("HTTPS 证据链接（不含查询参数）", { exact: true }).fill("https://example.invalid/submissions/browser-fixture");
  const confirm = page.getByRole("checkbox", { name: /我确认这是人工提供的外部回执/ });
  await confirm.check();
  await page.getByLabel("备注（不要填写凭据）", { exact: true }).fill("Browser fixture only, not an actual Store submission");
  await expect(confirm).not.toBeChecked();
  await expect(save).toBeDisabled();
  await confirm.check();
  await save.click();
  await expect(page.getByText("（人工记录，平台未核实）", { exact: true })).toBeVisible();
  await expect(confirm).not.toBeChecked();
  await page.reload();
  await expect(page.getByText(/回执 browser-fixture-ticket/)).toBeVisible();
  await expect(page.getByRole("button", { name: "执行分发（待正式审批）" })).toBeDisabled();
  expect(errors).toEqual([]);
  await page.screenshot({ path: screenshot("phase3-channels-desktop-fixture"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "切换暗色模式" }).click();
  await expect(page.locator("html")).toHaveClass("dark");
  expect((await page.getByLabel("渠道版本（X.Y.Z）").boundingBox())!.width).toBeGreaterThan(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: screenshot("phase3-channels-mobile-dark-fixture") });
  await page.getByRole("heading", { name: "v1.5.2 · 交接计划", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshot("phase3-handoff-mobile-dark-fixture") });
});

test("channel errors and missing formal source never create a plan or enable distribution", async ({ page }) => {
  await page.goto("/#channels");
  await page.getByLabel("渠道版本（X.Y.Z）").fill("9.9.9");
  await page.getByRole("button", { name: "查看本地记录", exact: true }).click();
  await expect(page.getByText("当前查看 v9.9.9 · 外部状态以观察时间为准", { exact: true })).toBeVisible();
  await expect(page.getByText("尚未查询", { exact: true })).toHaveCount(3);
  await page.getByRole("button", { name: "查询渠道", exact: true }).click();
  await expect(page.getByText("查询异常", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("当前可查询提交没有匹配的包版本", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "生成 / 恢复计划", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("heading", { name: "v9.9.9 · 交接计划", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "执行分发（待正式审批）" })).toBeDisabled();
  await page.screenshot({ path: screenshot("phase3-channels-error-fixture") });
  await page.getByLabel("渠道版本（X.Y.Z）").fill("v1.5.2; unsafe");
  await page.getByRole("button", { name: "查看本地记录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("渠道版本必须为 X.Y.Z");
});

test("late channel reads cannot replace the newly selected version, including SSE reloads", async ({ page }) => {
  // Hold the first response until the new version is visible. A fixed sleep or
  // a transient loading spinner can disappear before Playwright observes it.
  let first = true;
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await page.route("**/api/channels?version=1.5.2", async (route) => {
    if (first) { first = false; await firstHeld; }
    await route.continue();
  });
  await page.goto("/#channels");
  await expect.poll(() => first, { message: "initial channels request was intercepted" }).toBe(false);
  await page.getByLabel("渠道版本（X.Y.Z）").fill("2.0.0");
  await page.getByRole("button", { name: "查看本地记录", exact: true }).click();
  await expect(page.getByText("当前查看 v2.0.0 · 外部状态以观察时间为准", { exact: true })).toBeVisible();
  const staleResponse = page.waitForResponse((response) => response.url().includes("/api/channels?version=1.5.2"));
  releaseFirst();
  await staleResponse;
  await page.waitForTimeout(100); // allow React to process the deliberately stale response
  await expect(page.getByText("当前查看 v2.0.0 · 外部状态以观察时间为准", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "v1.5.2 · 交接计划", exact: true })).toHaveCount(0);
});
