import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";

const searchSelector = "input[data-mobile-knowledge-tree-search], input[data-knowledge-tree-search]";
const version = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
let tokens: { token: string; refreshToken: string };

test.beforeAll(async ({ request }) => {
  const response = await request.post("/api/auth/login", {
    data: { username: "assets_qa", password: "assets-qa-only-password" },
  });
  expect(response.ok()).toBe(true);
  tokens = await response.json();
});

async function openMobileSidebar(page: Page) {
  const back = page.getByRole("button", { name: "返回", exact: true });
  const menu = page.locator("button:visible").filter({ has: page.locator("svg.lucide-menu") }).first();
  await expect(back.or(menu).first()).toBeVisible();
  if (await back.isVisible()) await back.click();
  await menu.click();
  const sidebar = page.locator('[data-sidebar-variant="mobile"]:visible');
  await expect(sidebar).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox())?.x ?? -Infinity).toBeGreaterThanOrEqual(-1);
  return sidebar;
}

async function fitsSidebar(sidebar: Locator, element: Locator) {
  await expect(element).toBeVisible();
  const bounds = await sidebar.boundingBox();
  const box = await element.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
  // The visible shortcut rail narrows a 320px drawer; keep room for four Chinese characters.
  expect(box!.width).toBeGreaterThanOrEqual(bounds!.width < 280 ? 64 : 100);
}

async function assertHeaderAlignment(page: Page, sidebar: Locator, expanded: boolean) {
  const header = sidebar.locator("header");
  const elements = {
    rail: page.locator("[data-mobile-rail-hide]:visible > svg"),
    fold: header.locator(":scope > div:first-child > button > svg"),
    title: header.locator("[data-sidebar-title]"),
    close: header.getByRole("button", { name: "关闭", exact: true }).locator("svg"),
  };
  const originalInset = await page.locator("html").evaluate(element => ({
    value: element.style.getPropertyValue("--safe-area-top"),
    priority: element.style.getPropertyPriority("--safe-area-top"),
  }));
  const measurements = [];
  for (const safeAreaTop of [null, 24, 52]) {
    if (safeAreaTop !== null) {
      await page.locator("html").evaluate((element, inset) => element.style.setProperty("--safe-area-top", `${inset}px`, "important"), safeAreaTop);
    }
    const centers = Object.fromEntries(await Promise.all(Object.entries(elements).map(async ([name, element]) => {
      const box = (await element.boundingBox())!;
      return [name, box.y + box.height / 2];
    })));
    for (const name of ["fold", "title", "close"]) {
      expect(Math.abs(centers[name] - centers.rail), `${name} aligns with the rail at safe area ${safeAreaTop ?? "default"}`).toBeLessThanOrEqual(0.5);
    }
    measurements.push({ expanded, safeAreaTop, centers });
  }
  await page.locator("html").evaluate((element, original) => {
    if (original.value) element.style.setProperty("--safe-area-top", original.value, original.priority);
    else element.style.removeProperty("--safe-area-top");
  }, originalInset);
  return measurements;
}

for (const width of [320, 390]) {
  for (const mode of ["navigator", "tree"] as const) {
    for (const railHidden of [false, true]) {
      const nativeStyle = width === 320 && railHidden || width === 390 && mode === "tree";
      const theme = (width === 320) === railHidden ? "dark" : "light";
      test.describe(`sidebar search ${width}px ${mode} rail ${railHidden ? "hidden" : "shown"} ${theme}${nativeStyle ? " Android styles" : ""}`, () => {
        test.use({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });

        test("keeps search reachable while folded and preserves it across expanding", async ({ page }) => {
          await page.emulateMedia({ reducedMotion: width === 320 ? "reduce" : "no-preference" });
          await page.addInitScript(({ tokens, version, mode, railHidden, theme }) => {
            localStorage.setItem("nowen-token", tokens.token);
            localStorage.setItem("nowen-refresh-token", tokens.refreshToken);
            localStorage.setItem("i18nextLng", "zh-CN");
            localStorage.setItem("nowen-seen-version", version);
            localStorage.setItem("nowen.mobileKnowledgeTree.viewMode.v1", mode);
            localStorage.setItem("nowen-mobile-rail-hidden", String(railHidden));
            localStorage.setItem("nowen-note-theme", theme);
          }, { tokens, version, mode, railHidden, theme });
          await page.goto("/");
          await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
          if (nativeStyle) {
            // Apply Android safe-area and touch CSS without enabling native auth/storage.
            await page.evaluate(() => document.documentElement.setAttribute("data-native", "android"));
          }
          const sidebar = await openMobileSidebar(page);
          const header = sidebar.locator("header");
          const slot = header.locator("[data-mobile-sidebar-search-slot]");
          const visibleSearch = sidebar.locator(searchSelector).filter({ visible: true });
          await expect(header).toHaveAttribute("data-mobile-controls-collapsed", "true");
          await expect(header.locator("[data-sidebar-title]")).toHaveText("Nowen Note");
          await expect(slot.locator(searchSelector)).toHaveCount(1);
          await expect(visibleSearch).toHaveCount(1);
          await expect(header.getByRole("button", { name: "展开目录工具区", exact: true })).toHaveAttribute("aria-expanded", "false");
          await expect(header.locator("[data-knowledge-tree-sort-slot]")).toHaveCount(0);
          await fitsSidebar(sidebar, visibleSearch);
          await expect(sidebar.locator('[data-knowledge-tree-select-id]').filter({ visible: true }).first()).toBeVisible();
          const foldButton = header.getByRole("button", { name: "展开目录工具区", exact: true });
          const actions = header.locator("[data-mobile-sidebar-actions] > button");
          await expect(actions).toHaveCount(railHidden ? 3 : 1);
          const foldBox = (await foldButton.boundingBox())!;
          const slotBox = (await slot.boundingBox())!;
          const sidebarBox = (await sidebar.boundingBox())!;
          expect(foldBox.width).toBeGreaterThanOrEqual(39.9);
          expect(foldBox.height).toBeGreaterThanOrEqual(39.9);
          expect(slotBox.y).toBeGreaterThanOrEqual(foldBox.y + foldBox.height);
          expect(Math.abs(slotBox.x - sidebarBox.x - 12)).toBeLessThanOrEqual(1.1);
          expect(Math.abs(sidebarBox.x + sidebarBox.width - slotBox.x - slotBox.width - 12)).toBeLessThanOrEqual(1.1);
          const actionBoxes = await Promise.all((await actions.all()).map(action => action.boundingBox()));
          for (const [index, box] of actionBoxes.entries()) {
            expect(box!.width).toBeGreaterThanOrEqual(39.9);
            expect(box!.height).toBeGreaterThanOrEqual(39.9);
            expect(slotBox.y).toBeGreaterThanOrEqual(box!.y + box!.height);
            if (index > 0) expect(Math.abs(box!.x - actionBoxes[index - 1]!.x - actionBoxes[index - 1]!.width)).toBeLessThanOrEqual(1);
          }
          const alignments = railHidden ? [] : await assertHeaderAlignment(page, sidebar, false);
          if (width === 390 && mode === "tree" && !railHidden) {
            // Exercise the lazy Android guard through the palette's existing application event.
            await page.evaluate(() => window.dispatchEvent(new CustomEvent("nowen:open-command-palette")));
            await expect(page.locator("style[data-mobile-drawer-ux]")).toBeAttached();
            const palette = page.getByRole("dialog", { name: "全局搜索与工作台命令", exact: true });
            await expect(palette).toBeVisible();
            const guarded = await assertHeaderAlignment(page, sidebar, false);
            fs.writeFileSync(test.info().outputPath("header-alignment-android-guard.json"), JSON.stringify(guarded, null, 2));
            await expect(header).toHaveCSS("padding-top", "44px");
            expect((await page.locator("[data-mobile-rail-hide]:visible").boundingBox())!.height).toBeGreaterThanOrEqual(44);
            await page.keyboard.press("Escape");
            await expect(palette).toHaveCount(0);
            await expect(page.locator("style[data-mobile-drawer-ux]")).toHaveCount(0);
          }
          if (!railHidden) {
            const headerBox = (await header.boundingBox())!;
            await page.screenshot({
              path: test.info().outputPath("header-aligned-strip.png"),
              clip: { x: 0, y: 0, width, height: Math.ceil(headerBox.y + headerBox.height + 1) },
            });
          }
          await page.screenshot({ path: test.info().outputPath("folded-empty-search.png") });

          // Keyboard focus belongs to the whole search field, without a second inner outline.
          const restingBorder = await visibleSearch.evaluate(input => getComputedStyle(input.parentElement!).borderColor);
          await foldButton.focus();
          for (let index = 0; index <= actionBoxes.length; index++) await page.keyboard.press("Tab");
          await expect(visibleSearch).toBeFocused();
          await expect.poll(() => visibleSearch.evaluate((input, restingBorder) => {
            const field = getComputedStyle(input.parentElement!);
            return field.boxShadow !== "none" || field.borderColor !== restingBorder;
          }, restingBorder)).toBe(true);
          const inputFocus = await visibleSearch.evaluate(input => {
            const style = getComputedStyle(input);
            return { outline: style.outlineStyle, shadow: style.boxShadow };
          });
          expect(inputFocus).toEqual({ outline: "none", shadow: "none" });
          if (width === 320 && mode === "navigator" && railHidden) {
            await page.emulateMedia({ contrast: "more" });
            await expect.poll(() => visibleSearch.evaluate(input => Number.parseFloat(getComputedStyle(input.parentElement!).outlineWidth))).toBeGreaterThanOrEqual(2);
            await expect(visibleSearch).toHaveCSS("outline-style", "none");
            await page.emulateMedia({ contrast: "no-preference" });
          }

          await visibleSearch.fill("项目开发");
          await expect(sidebar.getByText("项目开发记录", { exact: true }).filter({ visible: true })).toHaveCount(1);
          await expect(sidebar.getByText("UI 设计规范", { exact: true }).filter({ visible: true })).toHaveCount(0);
          await page.screenshot({ path: test.info().outputPath("folded-search.png") });
          await fitsSidebar(sidebar, visibleSearch);
          fs.writeFileSync(test.info().outputPath("search-layout.json"), JSON.stringify({
            viewportWidth: width, mode, railHidden, sidebarWidth: sidebarBox.width,
            searchWidth: slotBox.width, filledInputWidth: (await visibleSearch.boundingBox())!.width,
          }));

          await header.getByRole("button", { name: "展开目录工具区", exact: true }).click();
          await expect(header).toHaveAttribute("data-mobile-controls-collapsed", "false");
          await expect(header.locator(searchSelector).filter({ visible: true })).toHaveCount(0);
          await expect(visibleSearch).toHaveCount(1);
          await expect(visibleSearch).toHaveValue("项目开发");
          await expect(header.getByRole("button", { name: "折叠目录工具区", exact: true })).toHaveAttribute("aria-expanded", "true");
          if (!railHidden) alignments.push(...await assertHeaderAlignment(page, sidebar, true));
          fs.writeFileSync(test.info().outputPath("header-alignment.json"), JSON.stringify(alignments, null, 2));
          await page.screenshot({ path: test.info().outputPath("expanded-search.png") });

          await header.getByRole("button", { name: "折叠目录工具区", exact: true }).click();
          await expect(slot.locator(searchSelector)).toHaveCount(1);
          await expect(visibleSearch).toHaveValue("项目开发");
          await header.getByRole("button", { name: /^清空(?:搜索|筛选)$/ }).click();
          await expect(visibleSearch).toHaveValue("");
          await expect(sidebar.getByText("QA notes", { exact: true }).filter({ visible: true })).toHaveCount(1);

          // The scope menu remains interactive after relocation, including its portal.
          await visibleSearch.fill("项目开发");
          await header.getByRole("button", { name: "搜索范围：目录", exact: true }).click();
          await page.getByRole("menu", { name: "搜索范围", exact: true })
            .getByRole("menuitemradio", { name: "笔记标题与正文", exact: true }).click();
          await expect(sidebar).toBeHidden();
          await expect(page.getByText("项目开发记录", { exact: true }).filter({ visible: true }).first()).toBeVisible();

          const reopened = await openMobileSidebar(page);
          const reopenedHeader = reopened.locator("header");
          const contentSearch = reopenedHeader.locator(searchSelector);
          await expect(contentSearch).toHaveCount(1);
          await expect(contentSearch).toHaveAttribute("data-search-scope", "content");
          await expect(contentSearch).toHaveValue("项目开发");
          await reopenedHeader.getByRole("button", { name: "搜索范围：全文", exact: true }).click();
          await page.getByRole("menu", { name: "搜索范围", exact: true })
            .getByRole("menuitemradio", { name: "目录与文档名称", exact: true }).click();
          await expect(contentSearch).toHaveAttribute("data-search-scope", "tree");
          await expect(reopened.locator(searchSelector).filter({ visible: true })).toHaveCount(1);
          await expect(reopenedHeader.locator("[data-knowledge-tree-sort-slot]")).toHaveCount(0);
          await fitsSidebar(reopened, contentSearch);
          await expect.poll(() => page.locator("body").evaluate(element => element.scrollWidth <= innerWidth + 1)).toBe(true);
        });
      });
    }
  }
}

test("desktop search stays in its toolbar with the site title in the header", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(({ tokens, version }) => {
    localStorage.setItem("nowen-token", tokens.token);
    localStorage.setItem("nowen-refresh-token", tokens.refreshToken);
    localStorage.setItem("i18nextLng", "zh-CN");
    localStorage.setItem("nowen-seen-version", version);
  }, { tokens, version });
  await page.goto("/");
  const sidebar = page.locator('[data-sidebar-variant="desktop"]:visible');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator("header")).toContainText("Nowen Note");
  await expect(sidebar.locator("header").locator(searchSelector)).toHaveCount(0);
  await expect(sidebar.locator("[data-mobile-sidebar-search-slot]")).toHaveCount(0);
  const search = sidebar.locator(searchSelector).filter({ visible: true });
  await expect(search).toHaveCount(1);
  await search.fill("项目开发");
  await expect(sidebar.getByText("项目开发记录", { exact: true })).toBeVisible();
});
