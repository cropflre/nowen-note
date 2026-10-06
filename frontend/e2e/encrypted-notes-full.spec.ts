import { test, expect, forbidden } from "./encrypted-notes-app-test";
import type { Page } from "@playwright/test";

const plaintext = `${forbidden[0]} embedded saved`;
const passphrase = forbidden[1];

async function unlockNote(page: Page) {
  await page.getByLabel("密码", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
}

for (const format of ["markdown", "tiptap-json"]) {
  test(`embedded ${format} whole note saves on background and survives process restart with ciphertext`, async ({ product }) => {
    let page = product.page;
    await page.getByRole("button", { name: "在根目录新建", exact: true }).click();
    await page.getByRole("menuitem", { name: "加密笔记", exact: true }).click();
    await page.getByLabel("加密笔记标题", { exact: true }).fill("Public embedded encrypted note");
    await page.getByLabel("加密笔记格式", { exact: true }).selectOption(format);
    await page.getByLabel("密码", { exact: true }).fill(passphrase);
    await page.getByLabel("确认密码", { exact: true }).fill(passphrase);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await unlockNote(page);
    const label = format === "markdown" ? "加密 Markdown 正文" : "加密富文本正文";
    const editor = page.getByLabel(label, { exact: true });
    await expect(editor).toBeVisible(); await editor.fill(plaintext);
    await expect(page.getByRole("status").filter({ hasText: "已保存" })).toBeVisible();
    await editor.fill(`${forbidden[0]} embedded unsaved`);
    await product.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window: { webContents: { getURL(): string } }) => window.webContents.getURL().includes("/frontend/dist/index.html"))!.hide());
    await expect(editor).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveCount(0);
    await product.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find((window: { webContents: { getURL(): string } }) => window.webContents.getURL().includes("/frontend/dist/index.html"))!; window.show(); window.focus(); });
    page = await product.restart();
    await page.getByText("Public embedded encrypted note", { exact: true }).first().click();
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
    await unlockNote(page);
    if (format === "markdown") await expect(page.getByLabel(label, { exact: true })).toHaveValue(`${forbidden[0]} embedded unsaved`);
    else await expect(page.getByLabel(label, { exact: true })).toHaveText(`${forbidden[0]} embedded unsaved`);
    await page.getByRole("button", { name: "锁定", exact: true }).click();
  });

  test(`embedded ${format} region autosaves ciphertext and drops its draft on restart`, async ({ product }) => {
    let page = product.page;
    await page.getByRole("button", { name: "在根目录新建", exact: true }).click();
    await page.getByRole("menuitem", { name: format === "markdown" ? "Markdown 文档" : "富文本文档", exact: true }).click();
    await page.getByLabel("新内容名称", { exact: true }).fill("Public embedded region note");
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "笔记标题", exact: true })).toHaveValue("Public embedded region note");
    const main = page.locator(format === "markdown" ? ".cm-content" : ".tiptap").first();
    await expect(main).toBeVisible(); await main.focus(); await page.keyboard.press("ControlOrMeta+End");
    async function openRegion() {
      if (format === "markdown") await page.getByRole("button", { name: "插入加密内容", exact: true }).click();
      else await page.locator('[title="插入加密内容"]').click();
    }
    await openRegion();
    await page.getByLabel("密码", { exact: true }).fill(passphrase);
    await page.getByLabel("确认密码", { exact: true }).fill(passphrase);
    await page.getByLabel("区域临时正文", { exact: true }).fill(plaintext);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const token = await page.evaluate(() => localStorage.getItem("nowen-token"));
    const headers = { Authorization: `Bearer ${token}` };
    const notes = await (await page.request.get(`${product.server}/api/notes`, { headers })).json();
    const note = notes.find((entry: { title: string }) => entry.title === "Public embedded region note");
    expect(note).toBeTruthy();
    await expect.poll(async () => (await (await page.request.get(`${product.server}/api/notes/${note.id}`, { headers })).json()).content)
      .toContain("nowen-encrypted-v1");
    async function viewRegion() {
      if (format === "markdown") {
        await page.getByRole("button", { name: "源码", exact: true }).click();
        const source = page.locator(".cm-content").first();
        await source.focus(); await page.keyboard.press("ControlOrMeta+Home");
        await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown");
        await openRegion();
      } else await page.getByRole("button", { name: "解锁加密内容", exact: true }).first().click();
      await page.getByLabel("密码", { exact: true }).fill(passphrase);
      await page.getByRole("dialog", { name: "局部加密区域", exact: true }).getByRole("button", { name: "解锁", exact: true }).click();
    }
    await viewRegion();
    await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveValue(plaintext);
    await page.getByLabel("区域临时正文", { exact: true }).fill(`${forbidden[0]} embedded unsaved region`);
    page.once("dialog", (dialog) => { void dialog.accept(); });
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveCount(0);
    page = await product.restart();
    await page.getByText("Public embedded region note", { exact: true }).first().click();
    await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveCount(0);
    if (format === "tiptap-json") await expect(page.locator(".tiptap").first()).toBeVisible();
    else await expect(page.getByRole("button", { name: "源码", exact: true })).toBeVisible();
    await viewRegion();
    await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveValue(plaintext);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
  });
}
