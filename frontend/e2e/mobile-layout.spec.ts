import { test, expect, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";

async function withinViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function navigate(page: Page, name: string) {
  if (page.viewportSize()!.width < 768) {
    const back = page.getByRole("button", { name: "返回", exact: true });
    if (await back.isVisible()) await back.click();
    await page.locator("button:visible").filter({ has: page.locator("svg.lucide-menu") }).first().click();
  }
  await page.getByRole("button", { name, exact: true }).click();
  if (name !== "设置") await expect(page.locator(".fixed.inset-y-0.left-0.z-50.w-screen")).toHaveCount(0);
}

let tokens: { token: string; refreshToken: string };
test.beforeAll(async ({ request }) => {
  const response = await request.post("/api/auth/login", { data: { username: "assets_qa", password: "assets-qa-only-password" } });
  expect(response.ok()).toBe(true);
  tokens = await response.json();
});

for (const width of [1600, 1024, 768, 800, 839]) {
  test(`All Notes honors standard layout and restores three columns (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(({ tokens }) => {
      localStorage.setItem("nowen-token", tokens.token);
      localStorage.setItem("nowen-refresh-token", tokens.refreshToken);
      localStorage.setItem("i18nextLng", "zh-CN");
    }, { tokens });
    await page.goto("/notes/assets-qa-reference-0");
    const allNotes = page.getByRole("button", { name: "所有笔记", exact: true });
    await allNotes.click();
    const trigger = page.getByTestId("note-workspace-layout-trigger");
    const list = page.getByTestId("note-workspace-list-pane");
    const editor = page.getByTestId("note-workspace-editor-pane");
    await trigger.click();
    await page.getByRole("menuitemradio", { name: "标准模式" }).click();
    await expect(list).toBeHidden();
    const directory = page.locator('[data-sidebar-variant="desktop"]');
    await expect(directory).toBeVisible();
    await expect(directory.locator('[data-knowledge-tree-node-id]').first()).toBeVisible();
    await expect(editor).toBeVisible();
    const standardWidth = (await editor.boundingBox())!.width;
    await page.reload();
    await expect(trigger).toBeVisible();
    await expect(list).toBeHidden();
    await expect(directory).toBeVisible();
    await allNotes.click();
    await expect(list).toBeHidden();
    await page.screenshot({ path: test.info().outputPath(`standard-${width}.png`) });

    // Narrow windows collapse three columns automatically, retaining the preference.
    await trigger.click();
    await page.getByRole("menuitemradio", { name: "三栏模式" }).click();
    if (width < 1120) {
      await expect(list).toBeHidden();
      await page.setViewportSize({ width: 1600, height: 900 });
    }
    await expect(list).toBeVisible();
    await expect(directory).toBeVisible();
    if (width === 1600) expect((await editor.boundingBox())!.width).toBeLessThan(standardWidth);
    await expect.poll(() => page.locator("body").evaluate(el => el.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`three-column-${width}.png`) });
    await page.setViewportSize({ width: 800, height: 1280 });
    await expect(list).toBeHidden();
    await expect(directory).toBeVisible();
    await expect(editor).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("nowen-note-workspace-layout"))).toBe("three-column");
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(list).toBeVisible();
  });
}

for (const width of [320, 390, 430, 1280]) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: width === 1280 ? 900 : 844 }, isMobile: width < 768, hasTouch: width < 768 });
    test.beforeEach(async ({ page }) => {
      const version = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
      await page.addInitScript(({ tokens, version }) => {
        localStorage.setItem("nowen-token", tokens.token);
        localStorage.setItem("nowen-refresh-token", tokens.refreshToken);
        localStorage.setItem("i18nextLng", "zh-CN");
        localStorage.setItem("nowen-seen-version", version);
      }, { tokens, version });
      await page.goto("/");
      await expect(page.getByRole("button", { name: "插入加密内容", exact: true })).toBeVisible();
    });

    test("files: compact grid, filters and list actions fit", async ({ page }) => {
      await page.route("**/api/files?*", async route => {
        const response = await route.fetch();
        const data = await response.json();
        await route.fulfill({ response, json: { ...data, items: data.items.map((item: Record<string, unknown>, index: number) => index === 0 ? { ...item, filename: "超长文件名".repeat(20) + ".png" } : item) } });
      });
      await navigate(page, "文件管理");
      await expect(page.getByRole("heading", { name: "全部文件", exact: true })).toBeVisible();
      const main = page.locator("main");
      await withinViewport(page, main.getByRole("textbox", { name: "搜索文件名" }));
      await withinViewport(page, main.getByRole("button", { name: "上传文件", exact: true }).first());
      const cards = main.locator('[role="button"][aria-pressed]');
      await expect(cards.first()).toBeVisible();
      if (width < 768) {
        const a = await cards.nth(0).boundingBox();
        const b = await cards.nth(1).boundingBox();
        expect(a!.y).toBe(b!.y);
        expect(b!.x).toBeGreaterThan(a!.x);
      }
      await page.screenshot({ path: `node_modules/.cache/mobile-layout-results/grid-${width}.png` });
      await main.getByRole("button", { name: "筛选", exact: true }).click();
      await withinViewport(page, main.getByLabel("文件格式", { exact: true }));
      await main.getByRole("button", { name: "筛选", exact: true }).click();
      await main.getByRole("button", { name: "列表视图", exact: true }).click();
      await withinViewport(page, cards.first().getByRole("button"));
      await expect.poll(() => main.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `node_modules/.cache/mobile-layout-results/files-${width}.png` });
      for (const folder of ["项目资料", "设计素材", "参考图片"]) await main.getByRole("button", { name: folder, exact: true }).click();
      const breadcrumb = main.getByRole("navigation", { name: "文件路径" });
      await breadcrumb.getByRole("button", { name: "参考图片", exact: true }).scrollIntoViewIfNeeded();
      await withinViewport(page, breadcrumb.getByRole("button", { name: "参考图片", exact: true }));
      expect((await breadcrumb.boundingBox())!.height).toBeLessThanOrEqual(40);
    });

    test("AI: conversation drawer leaves chat width intact and composer remains visible", async ({ page }) => {
      const title = "长对话标题".repeat(20);
      await page.route("**/api/ai/conversations", route => route.fulfill({ json: { conversations: [{ id: "layout-history", title, messageCount: 1, updatedAt: "2026-10-16T00:00:00Z" }] } }));
      await page.route("**/api/ai/chat-history?*", route => route.fulfill({ json: { conversationId: "layout-history", messages: [{ id: "layout-answer", role: "assistant", content: "长内容回归\n\nhttps://example.com/" + "a".repeat(240) + "\n\n```txt\n" + "wide-code".repeat(80) + "\n```\n\n| Column | Value |\n| --- | --- |\n| text | " + "wide-table".repeat(50) + " |", createdAt: "2026-10-16T00:00:00Z" }] } }));
      await navigate(page, "AI 问答");
      const composer = page.getByRole("textbox", { name: "输入你的问题，AI 将基于知识库回答..." });
      await withinViewport(page, composer);
      await withinViewport(page, page.getByTitle("AI 配置", { exact: true }));
      if (width < 768) expect((await page.locator("[data-ai-chat-header]").boundingBox())!.height).toBeLessThanOrEqual(100);
      const sidebar = page.getByRole("complementary", { name: "历史对话" });
      if (width < 768) await expect(page.getByTitle("展开上下文详情")).toHaveAttribute("aria-expanded", "false");
      if (width < 768) {
        await expect(sidebar).toBeHidden();
        const before = await composer.boundingBox();
        await page.getByTitle("展开对话列表", { exact: true }).click();
        await withinViewport(page, sidebar);
        await expect(page.getByTitle("AI 配置", { exact: true })).toBeAttached();
        expect((await composer.boundingBox())!.width).toBe(before!.width);
        await sidebar.getByRole("button", { name: "收起对话列表" }).click();
        await expect(sidebar).toBeHidden();
      } else await expect(sidebar).toBeVisible();
      await expect(page.getByText("长内容回归", { exact: true })).toBeVisible();
      const answer = await page.locator(".markdown-body").boundingBox();
      expect(answer!.x + answer!.width).toBeLessThanOrEqual(width + 1);
      await composer.fill("手机端测试：长内容 https://example.com/" + "a".repeat(180));
      await withinViewport(page, page.getByTitle("发送", { exact: true }));
      await expect.poll(() => page.locator("body").evaluate(el => el.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `node_modules/.cache/mobile-layout-results/ai-${width}.png` });
    });

    test("users: information, all four actions and short-screen modal stay reachable", async ({ page }) => {
      await page.route(/\/api\/users(?:\?|$)/, async route => {
        const response = await route.fetch();
        const users = await response.json();
        await route.fulfill({ response, json: users.map((user: Record<string, unknown>) => ({ ...user, displayName: "很长的用户显示名称".repeat(8), email: "long-email-address".repeat(10) + "@example.com" })) });
      });
      await navigate(page, "设置");
      await page.getByRole("button", { name: "用户管理", exact: true }).click();
      const card = page.locator("li").filter({ has: page.getByTitle("重置密码", { exact: true }) }).first();
      await expect(card).toBeVisible();
      for (const title of ["编辑", "重置密码", "禁用账号", "删除用户"]) await withinViewport(page, card.getByTitle(title, { exact: true }));
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: `node_modules/.cache/mobile-layout-results/user-cards-${width}.png` });
      await page.getByRole("button", { name: "新建用户", exact: true }).click();
      await page.setViewportSize({ width, height: 480 });
      const form = page.locator("form").filter({ has: page.getByRole("button", { name: "创建", exact: true }) });
      await form.getByRole("button", { name: "创建", exact: true }).scrollIntoViewIfNeeded();
      await withinViewport(page, form.getByRole("button", { name: "创建", exact: true }));
      await page.screenshot({ path: `node_modules/.cache/mobile-layout-results/users-${width}.png` });
    });
  });
}

const navigationRailCases = [
  { width: 320, height: 640, nativeStyle: false, textStyle: "readable", scale: 1 },
  { width: 320, height: 480, nativeStyle: false, textStyle: "classic", scale: 2 },
  { width: 390, height: 640, nativeStyle: false, textStyle: "readable", scale: 2 },
  { width: 320, height: 480, nativeStyle: true, textStyle: "readable", scale: 2 },
  { width: 390, height: 640, nativeStyle: true, textStyle: "classic", scale: 2 },
  { width: 390, height: 640, nativeStyle: true, textStyle: "readable", scale: 1 },
  { width: 1280, height: 900, nativeStyle: false, textStyle: "readable", scale: 1 },
] as const;

for (const scenario of navigationRailCases) {
  const mobile = scenario.width < 768;
  test.describe(`navigation rail ${scenario.width}px ${scenario.nativeStyle ? "Android styles" : "Web"} ${scenario.textStyle} ${scenario.scale * 100}% text`, () => {
    test.use({ viewport: { width: scenario.width, height: scenario.height }, isMobile: mobile, hasTouch: mobile });

    test("keeps complete labels and bottom actions reachable", async ({ page }) => {
      const version = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
      await page.addInitScript(({ tokens, version, textStyle }) => {
        localStorage.setItem("nowen-token", tokens.token);
        localStorage.setItem("nowen-refresh-token", tokens.refreshToken);
        localStorage.setItem("i18nextLng", "zh-CN");
        localStorage.setItem("nowen-seen-version", version);
        localStorage.setItem("nowen-rail-mode", "label");
        localStorage.setItem("nowen-mobile-rail-hidden", "0");
        localStorage.setItem("nowen.sidebar.textStyle.v1", textStyle);
      }, { tokens, version, textStyle: scenario.textStyle });
      await page.goto("/");
      if (mobile) {
        const back = page.getByRole("button", { name: "返回", exact: true });
        const menu = page.locator("button:visible").filter({ has: page.locator("svg.lucide-menu") }).first();
        await expect(back.or(menu).first()).toBeVisible();
        if (await back.isVisible()) await back.click();
        await menu.click();
      }
      const rail = page.locator(".nav-rail:visible");
      await expect(rail).toHaveCount(1);
      await expect(rail.getByRole("button", { name: "所有笔记", exact: true })).toBeVisible();
      // Wait for asynchronously mounted plugin and space entries, so they receive the same checks.
      await expect(rail.getByRole("button", { name: "应用", exact: true })).toBeVisible();
      await expect(rail.getByRole("button", { name: "空间", exact: true })).toBeVisible();
      await expect.poll(async () => (await rail.boundingBox())?.x ?? -Infinity).toBeGreaterThanOrEqual(-1);
      if (scenario.nativeStyle) {
        // Exercise Android CSS without enabling Capacitor or its native storage/auth bridges.
        await page.evaluate(() => document.documentElement.setAttribute("data-native", "android"));
      }
      if (mobile) {
        await page.evaluate(() => {
          document.documentElement.style.setProperty("--safe-area-top", "24px", "important");
          document.documentElement.style.setProperty("--safe-area-bottom", "16px", "important");
        });
      }

      // Root-font scaling misses px-sized rail labels. Enlarge their actual computed font
      // sizes instead, preserving the app's own line-height, wrapping and item sizing.
      const enlarged = await rail.evaluate((element, scale) => {
        return Array.from(element.querySelectorAll<HTMLButtonElement>("button[aria-label]")).flatMap(button => {
          const label = button.querySelector<HTMLElement>(":scope > span:last-child");
          if (!label?.textContent?.trim() || !button.getClientRects().length) return [];
          const fontSize = Number.parseFloat(getComputedStyle(label).fontSize) * scale;
          label.style.setProperty("font-size", `${fontSize}px`, "important");
          return [{ name: label.textContent.trim(), fontSize }];
        });
      }, scenario.scale);
      expect(enlarged.map(label => label.name)).toEqual(expect.arrayContaining(["所有笔记", "每日记录", "应用", "工作台", "空间", "退出登录"]));
      await page.screenshot({ path: test.info().outputPath("rail-top.png") });

      const measurements = await rail.evaluate(element => {
        const bounds = (rect: DOMRect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
        return Array.from(element.querySelectorAll<HTMLButtonElement>("button[aria-label]")).flatMap(button => {
          const label = button.querySelector<HTMLElement>(":scope > span:last-child");
          if (!label?.textContent?.trim() || !button.getClientRects().length) return [];
          const range = document.createRange();
          range.selectNodeContents(label);
          const style = getComputedStyle(label);
          return [{
            name: label.textContent.trim(), button: bounds(button.getBoundingClientRect()),
            lines: Array.from(range.getClientRects(), bounds),
            fontSize: Number.parseFloat(style.fontSize), lineHeight: Number.parseFloat(style.lineHeight),
            clientWidth: label.clientWidth, scrollWidth: label.scrollWidth,
            clientHeight: label.clientHeight, scrollHeight: label.scrollHeight,
          }];
        });
      });
      expect(measurements).toHaveLength(enlarged.length);
      for (const [index, item] of measurements.entries()) {
        expect(item.fontSize, `${item.name} preserves enlarged text`).toBeCloseTo(enlarged[index].fontSize, 1);
        if (mobile) {
          expect(item.lineHeight, `${item.name} line height`).toBeGreaterThanOrEqual(item.fontSize * 1.2);
          expect(item.scrollWidth, `${item.name} horizontal clipping`).toBeLessThanOrEqual(item.clientWidth + 1);
          expect(item.scrollHeight, `${item.name} vertical clipping`).toBeLessThanOrEqual(item.clientHeight + 1);
          for (const line of item.lines) {
            expect(line.left, `${item.name} text left edge`).toBeGreaterThanOrEqual(item.button.left - 1);
            expect(line.right, `${item.name} text right edge`).toBeLessThanOrEqual(item.button.right + 1);
            expect(line.top, `${item.name} text top edge`).toBeGreaterThanOrEqual(item.button.top - 1);
            expect(line.bottom, `${item.name} text bottom edge`).toBeLessThanOrEqual(item.button.bottom + 1);
          }
          if (index > 0) expect(item.button.top, `${item.name} overlaps previous item`).toBeGreaterThanOrEqual(measurements[index - 1].button.bottom - 1);
        }
      }
      const railBox = (await rail.boundingBox())!;
      expect(railBox.width).toBeGreaterThanOrEqual(64);
      expect(railBox.width).toBeLessThanOrEqual(mobile ? 96 : 64);

      const logout = rail.getByRole("button", { name: "退出登录", exact: true });
      await logout.scrollIntoViewIfNeeded();
      await withinViewport(page, logout);
      if (mobile) {
        const scrollport = rail.locator(".nav-rail-scroll");
        expect((await scrollport.boundingBox())!.y).toBeGreaterThanOrEqual(24);
        expect(await rail.evaluate(element => element.scrollTop)).toBe(0);
        if (scenario.scale === 2) expect(await scrollport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        expect(await page.evaluate(x => document.elementFromPoint(x, 23)?.closest("button") == null, railBox.x + railBox.width / 2)).toBe(true);
      }
      await page.screenshot({ path: test.info().outputPath("rail-bottom.png") });
      const settings = rail.getByRole("button", { name: "设置", exact: true });
      await settings.scrollIntoViewIfNeeded();
      await withinViewport(page, settings);
      await settings.click();
      await expect(page.locator('[data-swipe-blocker="settings-modal"]')).toBeVisible();
    });
  });
}
