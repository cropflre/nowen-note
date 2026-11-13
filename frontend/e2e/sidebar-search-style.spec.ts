import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";

const version = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
let tokens: { token: string; refreshToken: string };

test.beforeAll(async ({ request }) => {
  const response = await request.post("/api/auth/login", {
    data: { username: "assets_qa", password: "assets-qa-only-password" },
  });
  expect(response.ok()).toBe(true);
  tokens = await response.json();
});

async function openFixture(page: Page, mode: "tree" | "quick", theme: "light" | "dark", width = 300) {
  await page.addInitScript(({ tokens, version, mode, theme, width }) => {
    localStorage.setItem("nowen-token", tokens.token);
    localStorage.setItem("nowen-refresh-token", tokens.refreshToken);
    localStorage.setItem("i18nextLng", "zh-CN");
    localStorage.setItem("nowen-seen-version", version);
    localStorage.setItem("nowen.desktopKnowledgeTree.viewMode.v1", mode);
    localStorage.setItem("nowen.mobileKnowledgeTree.viewMode.v1", mode === "tree" ? "tree" : "navigator");
    localStorage.setItem("nowen-sidebar-width", String(width));
    localStorage.setItem("nowen-note-theme", theme);
    localStorage.setItem("nowen-note-skin", "macos");
  }, { tokens, version, mode, theme, width });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-skin", "macos");
  await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
}

async function assertSingleFocus(field: Locator, height: number) {
  const input = field.locator("input");
  await input.focus();
  await expect(input).toBeFocused();
  await expect(field).toHaveCSS("height", `${height}px`);
  expect(await input.getAttribute("title")).toBeNull();
  expect(await field.getAttribute("title")).toBeNull();
  await test.info().attach("input-focus-style", {
    body: JSON.stringify(await input.evaluate(element => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor, shadow: style.boxShadow };
    })),
    contentType: "application/json",
  });
  await expect.poll(() => input.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      outline: style.outlineStyle, shadow: style.boxShadow,
      borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
    };
  })).toEqual({ outline: "none", shadow: "none", borders: ["0px", "0px", "0px", "0px"] });
  await expect.poll(() => field.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe("none");
  await expect(field.locator(":scope > svg")).toHaveCount(1);
  expect(await field.evaluate(element => getComputedStyle(element, "::before").content)).toMatch(/^(none|normal)$/);
}

async function assertNoOverlap(field: Locator) {
  const metrics = await field.evaluate(element => {
    const rect = (target: Element) => {
      const bounds = target.getBoundingClientRect();
      return { x: bounds.x, right: bounds.right, y: bounds.y, bottom: bounds.bottom, center: bounds.y + bounds.height / 2 };
    };
    const visible = (target: Element) => target.getBoundingClientRect().width > 0 && target.getBoundingClientRect().height > 0;
    return {
      field: rect(element),
      parts: Array.from(element.querySelectorAll(":scope > svg, :scope > input, :scope > button")).filter(visible).map(rect).sort((a, b) => a.x - b.x),
      actions: Array.from(element.parentElement?.querySelectorAll(":scope > button") || []).filter(visible).map(rect),
    };
  });
  expect(metrics.parts.length).toBeGreaterThanOrEqual(3);
  for (let index = 0; index < metrics.parts.length; index += 1) {
    const part = metrics.parts[index];
    expect(part.x).toBeGreaterThanOrEqual(metrics.field.x);
    expect(part.right).toBeLessThanOrEqual(metrics.field.right);
    expect(part.y).toBeGreaterThanOrEqual(metrics.field.y);
    expect(part.bottom).toBeLessThanOrEqual(metrics.field.bottom);
    expect(Math.abs(part.center - metrics.field.center)).toBeLessThanOrEqual(1);
    if (index > 0) expect(part.x).toBeGreaterThanOrEqual(metrics.parts[index - 1].right - 0.5);
  }
  for (const action of metrics.actions) expect(action.x).toBeGreaterThanOrEqual(metrics.field.right - 0.5);
  return metrics;
}

async function fillAndClear(field: Locator, height: number) {
  const input = field.locator("input");
  await assertSingleFocus(field, height);
  await input.fill("1111");
  await expect(field).toHaveCSS("height", `${height}px`);
  await assertNoOverlap(field);
  await field.getByRole("button", { name: /^清空(?:搜索|筛选)$/ }).click();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(field).toHaveCSS("height", `${height}px`);
}

for (const mode of ["tree", "quick"] as const) {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [240, 300]) {
      test(`macos desktop ${mode} ${theme} ${width}px has one stable search surface`, async ({ page }) => {
        await openFixture(page, mode, theme, width);
        const sidebar = page.locator('[data-sidebar-variant="desktop"]:visible');
        await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(width);
        const field = sidebar.locator("[data-knowledge-search-field]:visible");
        await expect(field).toHaveCount(1);
        await fillAndClear(field, 36);
        const input = field.locator("input");
        await input.fill("1111");
        await assertNoOverlap(field);
        await expect(field.locator(":scope > svg.lucide-list-filter")).toHaveCount(1);
        await page.screenshot({ path: test.info().outputPath("focused-tree-search.png") });
        const [sidebarBox, fieldBox] = await Promise.all([sidebar.boundingBox(), field.boundingBox()]);
        await page.screenshot({
          path: test.info().outputPath("focused-search-strip.png"),
          clip: { x: sidebarBox!.x, y: fieldBox!.y - 8, width: sidebarBox!.width, height: fieldBox!.height + 16 },
        });
        await field.getByRole("button", { name: "搜索范围：目录", exact: true }).click();
        await page.getByRole("menu", { name: "搜索范围", exact: true })
          .getByRole("menuitemradio", { name: "笔记标题与正文", exact: true }).click();
        await expect(input).toHaveAttribute("data-search-scope", "content");
        await assertSingleFocus(field, 36);
        await assertNoOverlap(field);
        await expect(field.locator(":scope > svg.lucide-search")).toHaveCount(1);
        await field.getByRole("button", { name: "搜索范围：全文", exact: true }).click();
        await page.getByRole("menu", { name: "搜索范围", exact: true })
          .getByRole("menuitemradio", { name: "目录与文档名称", exact: true }).click();
        await expect(input).toHaveAttribute("data-search-scope", "tree");
        await input.focus();
        await assertNoOverlap(field);
        await page.screenshot({ path: test.info().outputPath("scope-switched-back.png") });
      });
    }
  }
}

test.describe("mobile macos search focus", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("keeps one focus surface when the drawer controls are folded and expanded", async ({ page }) => {
    await openFixture(page, "tree", "light");
    const back = page.getByRole("button", { name: "返回", exact: true });
    const menu = page.locator("button:visible").filter({ has: page.locator("svg.lucide-menu") }).first();
    await expect(back.or(menu).first()).toBeVisible();
    if (await back.isVisible()) await back.click();
    await menu.click();
    const sidebar = page.locator('[data-sidebar-variant="mobile"]:visible');
    const header = sidebar.locator("header");
    const field = sidebar.locator("[data-knowledge-search-field]:visible");
    await expect(header).toHaveAttribute("data-mobile-controls-collapsed", "true");
    await fillAndClear(field, 44);
    await page.screenshot({ path: test.info().outputPath("mobile-folded-focus.png") });
    await header.getByRole("button", { name: "展开目录工具区", exact: true }).click();
    await expect(header).toHaveAttribute("data-mobile-controls-collapsed", "false");
    await expect(field).toHaveCount(1);
    await fillAndClear(field, 44);
    await page.screenshot({ path: test.info().outputPath("mobile-expanded-focus.png") });
  });
});
