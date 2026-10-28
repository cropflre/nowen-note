import { test, expect } from "./encrypted-notes-app-test";
import fs from "node:fs";
const fixture = JSON.parse(fs.readFileSync(new URL("../src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), "utf8"));

for (const format of ["markdown", "tiptap-json"] as const) test(`Issue 875 permanently decrypts ${format}, preserves identity and reopens without a password`, async ({ product }) => {
  const { page, server, app } = product;
  const accountPassword = "decryption-account-password";
  const passphrase = format === "markdown" ? fixture.passphrase : "decryption-conversion-passphrase";
  const marker = format === "markdown" ? fixture.plaintext : "ISSUE_875_READABLE_BODY";
  const title = `Permanently decrypt ${format}`;
  const registered = await page.request.post(`${server}/api/auth/register`, { data: { username: "decrypt_product", password: accountPassword } });
  expect(registered.ok()).toBe(true);
  const account = await registered.json();
  const headers = { Authorization: `Bearer ${account.token}`, Accept: "application/vnd.nowen.internal-note+json" };
  const notebooks = await (await page.request.get(`${server}/api/notebooks`, { headers })).json();
  const personal = notebooks.find((row: { workspaceId?: string }) => !row.workspaceId);
  const body = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: marker, marks: [{ type: "bold" }] }] }] });
  const created = await page.request.post(`${server}/api/notes`, { headers, data: {
    notebookId: personal.id, title, contentFormat: format === "markdown" ? "encrypted-note-v1" : format,
    content: format === "markdown" ? JSON.stringify(fixture.envelope) : body,
  } });
  expect(created.status(), await created.text()).toBe(201);
  const original = await created.json();
  await page.getByPlaceholder("fnos.net/user:3001 或 192.168.1.10:3001", { exact: true }).fill(new URL(server).host);
  await page.getByPlaceholder("admin", { exact: true }).fill("decrypt_product");
  await page.getByPlaceholder("••••••••", { exact: true }).fill(accountPassword);
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await page.getByText(title, { exact: true }).first().click();
  if (format === "tiptap-json") {
    await expect(page.getByRole("textbox", { name: "笔记标题", exact: true })).toHaveValue(title);
    await page.locator('[data-editor-more-menu="desktop"]').getByRole("button").first().click();
    await page.getByRole("button", { name: "加密笔记", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "加密笔记", exact: true });
    await dialog.getByLabel("密码", { exact: true }).fill(passphrase);
    await dialog.getByLabel("确认密码", { exact: true }).fill(passphrase);
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "加密", exact: true }).click();
    await expect(dialog).not.toBeVisible({ timeout: 30000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window: { webContents: { getURL(): string } }) => window.webContents.getURL().includes("/frontend/dist/index.html"))!.setContentSize(390, 844));
  }
  await expect(page.getByRole("heading", { name: "此笔记已加密", exact: true })).toBeVisible();
  await page.getByLabel("密码", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  const editor = page.getByLabel(format === "markdown" ? "加密 Markdown 正文" : "加密富文本正文", { exact: true });
  await expect(editor).toBeVisible();
  await page.getByText("解除加密", { exact: true }).click();
  await page.getByLabel("确认当前加密密码", { exact: true }).fill("wrong-encryption-password");
  await page.getByRole("checkbox", { name: "我确认将正文和历史版本保存为明文。", exact: true }).check();
  await page.getByRole("button", { name: "确认解除加密", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  const unchanged = await (await page.request.get(`${server}/api/notes/${original.id}/encryption/decryption-source`, { headers })).json();
  expect(unchanged.note.contentFormat).toMatch(/^encrypted-note-v/);
  await page.getByLabel("确认当前加密密码", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "确认解除加密", exact: true }).click();
  await expect(editor).not.toBeVisible({ timeout: 30000 });
  await expect(page.getByRole("textbox", { name: "笔记标题", exact: true })).toHaveValue(title);
  const result = await (await page.request.get(`${server}/api/notes/${original.id}/encryption/decryption-source`, { headers })).json();
  expect(result.note.id).toBe(original.id); expect(result.note.notebookId).toBe(original.notebookId);
  expect(result.note.contentFormat).toBe(format); expect(result.note.content).toContain(marker);
  expect(result.history.every((row: { contentFormat: string }) => !row.contentFormat.startsWith("encrypted-"))).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith("nowen-encrypted-converted:")))).toBe(false);
  await page.reload();
  await expect(page.getByRole("heading", { name: "此笔记已加密", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "笔记标题", exact: true })).toHaveValue(title);
  await expect(page.getByTestId("note-workspace-editor-pane")).toContainText(marker.split("\n").filter(Boolean).at(-1)!);
});
