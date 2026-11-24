import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";

const version = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

async function openSidebar(page: Page, mobile: boolean) {
  if (mobile) await page.locator("button:visible").filter({ has: page.locator("svg.lucide-menu") }).first().click();
}

for (const { name, width, height, mobile } of [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
]) {
  test(`${name}: template picker follows language selection and fits the viewport`, async ({ page, request }) => {
    await page.setViewportSize({ width, height });
    const login = await request.post("/api/auth/login", { data: { username: "assets_qa", password: "assets-qa-only-password" } });
    expect(login.ok()).toBe(true);
    const tokens = await login.json();
    await page.addInitScript(({ tokens, version }) => {
      localStorage.setItem("nowen-token", tokens.token);
      localStorage.setItem("nowen-refresh-token", tokens.refreshToken);
      if (!localStorage.getItem("i18nextLng")) localStorage.setItem("i18nextLng", "en");
      localStorage.setItem("nowen-seen-version", version);
    }, { tokens, version });
    await page.goto("/");
    await openSidebar(page, mobile);
    await page.getByRole("button", { name: "Templates", exact: true }).first().click();
    let dialog = page.getByRole("dialog", { name: "Manage templates" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("No templates yet")).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
    await page.screenshot({ path: test.info().outputPath(`${name}-templates-en.png`) });
    await dialog.getByRole("button", { name: "Close template picker" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await page.getByRole("button", { name: "简体中文", exact: true }).click();
    await expect(page.getByRole("button", { name: "外观设置", exact: true }).first()).toBeVisible();
    await page.reload();
    await openSidebar(page, mobile);
    await page.getByRole("button", { name: "模板管理", exact: true }).first().click();
    dialog = page.getByRole("dialog", { name: "模板管理" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("暂无模板")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`${name}-templates-zh.png`) });
  });
}
