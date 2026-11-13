import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

interface ShareFixture {
  content?: string;
  format?: string;
  permission?: string;
  password?: boolean;
  conflict?: boolean;
  webUiEnabled?: boolean;
}

async function installShareFixture(page: Page, fixture: ShareFixture = {}) {
  const assets = new Set<string>();
  const writes: Record<string, unknown>[] = [];
  let contentRequests = 0;
  // The backend resolves /share/assets/* and reverse-proxy asset prefixes to dist/assets/*.
  await page.route("**/assets/**", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/assets/")[1];
    assets.add(name);
    await route.fulfill({ path: path.resolve("dist/assets", name) });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const permission = fixture.permission || "view";
    let body: unknown = {};
    let status = 200;
    if (pathname.endsWith("/settings")) {
      body = { web_ui_enabled: fixture.webUiEnabled === false ? "false" : "true" };
    } else if (/\/shared\/[^/]+$/.test(pathname)) {
      body = { id: "share-1", noteTitle: "低带宽分享", permission, needPassword: !!fixture.password, ownerName: "作者" };
    } else if (pathname.endsWith("/verify")) {
      status = request.postDataJSON().password === "correct" ? 200 : 403;
      body = status === 200 ? { success: true, accessToken: "fixture-access" } : { error: "密码错误" };
    } else if (pathname.endsWith("/content") && request.method() === "PUT") {
      writes.push(request.postDataJSON());
      status = fixture.conflict ? 409 : 200;
      body = fixture.conflict
        ? { error: "版本冲突", code: "VERSION_CONFLICT", currentVersion: 2 }
        : { success: true, version: 2, updatedAt: "2026-11-12T00:00:00Z" };
    } else if (pathname.endsWith("/content")) {
      contentRequests++;
      status = fixture.password && request.headers().authorization !== "Bearer fixture-access" ? 403 : 200;
      body = { title: "低带宽分享", content: fixture.content || "只有几个文字的分享。", contentFormat: fixture.format || "markdown", permission, version: 1, updatedAt: "2026-11-12T00:00:00Z" };
    } else if (pathname.endsWith("/comments")) body = [];
    else if (pathname.endsWith("/poll")) body = { version: 1 };
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { assets, writes, contentRequests: () => contentRequests };
}

test("a small text share stays within the download budget without workspace/editor/highlighter chunks", async ({ page }, testInfo) => {
  const { assets } = await installShareFixture(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/share/abc_-123");
  await expect(page.getByRole("heading", { name: "低带宽分享", exact: true })).toBeVisible();
  await expect(page.locator("main")).toContainText("只有几个文字的分享。");
  await page.waitForLoadState("networkidle");
  expect([...assets].join("\n")).not.toMatch(/(?:^|\n)(?:App-|main-|GlobalBridges-|TiptapEditor|PlainTextEditor|coreRuntimeInstallers-|sharedCodeHighlight-|FullscreenImageViewer-)/);
  const files = await Promise.all([...assets].filter((name) => /\.(js|css)$/.test(name)).map(async (name) => {
    const bytes = await readFile(path.resolve("dist/assets", name));
    return { name, raw: bytes.length, gzip: gzipSync(bytes).length };
  }));
  const totals = files.reduce((sum, file) => ({ raw: sum.raw + file.raw, gzip: sum.gzip + file.gzip }), { raw: 0, gzip: 0 });
  await testInfo.attach("resource-budget", { body: JSON.stringify({ files, totals }, null, 2), contentType: "application/json" });
  expect(totals.raw).toBeLessThan(1_800_000);
  expect(totals.gzip).toBeLessThan(500_000);
  expect(errors).toEqual([]);
});

test("password protection does not fetch content until verification succeeds", async ({ page }) => {
  const fixture = await installShareFixture(page, { password: true });
  await page.goto("/share/abc_-123");
  const password = page.locator('input[type="password"]');
  await expect(password).toBeVisible();
  expect(fixture.contentRequests()).toBe(0);
  await password.fill("wrong");
  await password.press("Enter");
  await expect(page.getByText("密码错误", { exact: true })).toBeVisible();
  expect(fixture.contentRequests()).toBe(0);
  await password.fill("correct");
  await password.press("Enter");
  await expect(page.locator("main")).toContainText("只有几个文字的分享。");
  expect(fixture.contentRequests()).toBeGreaterThan(0);
});

test("shares respect the administrator's disabled web UI setting", async ({ page }) => {
  const fixture = await installShareFixture(page, { webUiEnabled: false });
  await page.goto("/share/abc_-123");
  await expect(page.getByRole("heading", { name: "网页端已被管理员关闭" })).toBeVisible();
  expect(fixture.contentRequests()).toBe(0);
});

test("rich-text code loads its highlighter on demand and preserves escaped code", async ({ page }) => {
  const { assets } = await installShareFixture(page, {
    content: JSON.stringify({ type: "doc", content: [{ type: "codeBlock", attrs: { language: "javascript" }, content: [{ type: "text", text: 'const text = "<script>";' }] }] }),
    format: "tiptap-json",
  });
  await page.goto("/share/abc_-123");
  await expect(page.locator(".shared-code-content .hljs-keyword")).toBeVisible();
  await expect(page.locator(".shared-code-content")).toHaveText('const text = "<script>";');
  expect([...assets].some((name) => name.startsWith("sharedCodeHighlight-"))).toBe(true);
  expect([...assets].some((name) => name.startsWith("TiptapEditor"))).toBe(false);
});

test("DCC-004: lazy guest editor retains the local text when a version conflict rejects saving", async ({ page }) => {
  const { assets, writes } = await installShareFixture(page, { format: "plaintext", permission: "edit", conflict: true });
  await page.addInitScript(() => localStorage.setItem("nowen-guest-name", "测试访客"));
  await page.goto("/share/abc_-123");
  await expect(page.getByRole("button", { name: "开始编辑", exact: true })).toBeVisible();
  expect([...assets].some((name) => name.startsWith("PlainTextEditor-"))).toBe(false);
  await page.getByRole("button", { name: "开始编辑", exact: true }).click();
  const editor = page.locator(".shared-note-editor textarea");
  await expect(editor).toBeVisible();
  await editor.fill("保留我的未保存修改");
  await expect(page.getByText("内容已被其他人更新，请点击顶部『刷新』后再编辑", { exact: true })).toBeVisible();
  await expect(editor).toHaveValue("保留我的未保存修改");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ content: "保留我的未保存修改", contentFormat: "plaintext", version: 1, guestName: "测试访客" });
});

test("rich-text guest editing mounts on demand and saves with the original version", async ({ page }) => {
  const { writes } = await installShareFixture(page, {
    content: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "原正文" }] }] }),
    format: "tiptap-json", permission: "edit",
  });
  await page.addInitScript(() => localStorage.setItem("nowen-guest-name", "测试访客"));
  await page.goto("/share/abc_-123");
  await page.getByRole("button", { name: "开始编辑", exact: true }).click();
  const editor = page.locator('.shared-note-editor .ProseMirror[contenteditable="true"]');
  await expect(editor).toBeVisible();
  await editor.fill("按需加载后编辑");
  await expect.poll(() => writes.some((write) => String(write.content).includes("按需加载后编辑"))).toBe(true);
  expect(writes.find((write) => String(write.content).includes("按需加载后编辑")))
    .toMatchObject({ contentFormat: "tiptap-json", guestName: "测试访客" });
});

test("the image lightbox downloads only after clicking a shared image", async ({ page }) => {
  const { assets } = await installShareFixture(page, { content: "![示例](/fixture-image.svg)" });
  await page.route("**/fixture-image.svg", (route) => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="blue"/></svg>',
  }));
  await page.goto("/share/abc_-123");
  const image = page.locator("main img");
  await expect(image).toBeVisible();
  expect([...assets].some((name) => name.startsWith("FullscreenImageViewer-"))).toBe(false);
  await image.click();
  await expect(page.getByRole("dialog", { name: "图片预览" })).toBeVisible();
  expect([...assets].some((name) => name.startsWith("FullscreenImageViewer-"))).toBe(true);
  await page.getByRole("button", { name: "关闭图片预览", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "图片预览" })).toBeHidden();
});
