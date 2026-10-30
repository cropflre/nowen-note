import { test, expect } from "./encrypted-notes-app-test";

for (const format of ["markdown", "tiptap-json"] as const) test(`AppShell converts existing ${format} in place, preserves history and edits only ciphertext`, async ({ product }) => {
  const { page, server, app } = product;
  const password = "test-only-account-password", passphrase = "conversion-only-long-password";
  const title = `Convert product ${format}`;
  const marker = "CONVERSION_PRODUCT_BODY", historyMarker = "CONVERSION_PRODUCT_HISTORY";
  const registered = await page.request.post(`${server}/api/auth/register`, { data: { username: "convert_product", password } });
  expect(registered.ok()).toBe(true); const account = await registered.json();
  const headers = { Authorization: `Bearer ${account.token}`, Accept: "application/vnd.nowen.internal-note+json" };
  const body = (text: string) => format === "markdown" ? `# Heading\n\n**${text}**` : JSON.stringify({ type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Heading" }] }, { type: "paragraph", content: [{ type: "text", text, marks: [{ type: "bold" }] }] }] });
  const notebooks = await page.request.get(`${server}/api/notebooks`, { headers });
  const personal = (await notebooks.json()).find((entry: { workspaceId?: string | null; isDeleted?: number }) => !entry.workspaceId && !entry.isDeleted);
  const created = await page.request.post(`${server}/api/notes`, { headers, data: { title, content: format === "markdown" ? body(historyMarker) : "{}", contentFormat: format, notebookId: personal.id } });
  expect(created.status(), await created.text()).toBe(201); const original = await created.json();
  const updated = await page.request.put(`${server}/api/notes/${original.id}`, { headers, data: { version: original.version, content: body(marker), contentFormat: format } });
  expect(updated.ok()).toBe(true);
  // The merge window skips ordinary snapshots, so clearing generates a real
  // safety-trigger snapshot with its original 32-character ID.
  const beforeClear = await updated.json();
  const cleared = await page.request.put(`${server}/api/notes/${original.id}`, { headers, data: { version: beforeClear.version, content: format === "markdown" ? "" : '{"type":"doc","content":[]}', contentFormat: format } });
  expect(cleared.ok(), await cleared.text()).toBe(true);
  const restored = await page.request.put(`${server}/api/notes/${original.id}`, { headers, data: { version: (await cleared.json()).version, content: body(marker), contentFormat: format } });
  expect(restored.ok(), await restored.text()).toBe(true);
  await page.getByPlaceholder("fnos.net/user:3001 或 192.168.1.10:3001", { exact: true }).fill(new URL(server).host);
  await page.getByPlaceholder("admin", { exact: true }).fill("convert_product");
  await page.getByPlaceholder("••••••••", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await page.getByText(title, { exact: true }).first().click();
  await expect(page.getByRole("textbox", { name: "笔记标题", exact: true })).toHaveValue(title);
  await expect(page.getByText(marker, { exact: false }).first()).toBeVisible();
  // Exercise the same action on desktop and the narrow layout.
  if (format === "tiptap-json") await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((entry: { webContents: { getURL(): string } }) => entry.webContents.getURL().includes("/frontend/dist/index.html"))!.setContentSize(390, 844));
  if (format === "markdown") await page.locator('[data-editor-more-menu="desktop"]').getByRole("button").first().click();
  else await page.getByTestId("note-workspace-editor-pane").getByRole("button", { name: "更多", exact: true }).filter({ visible: true }).click();
  // A cache/replay operation in this same browser must drain automatically.
  await page.evaluate(() => new Promise<void>((ready) => {
    void navigator.locks.request("nowen-encrypted-conversion-replay:v1", { mode: "shared" }, async () => {
      ready(); await new Promise((resolve) => setTimeout(resolve, 500));
    });
  }));
  await page.getByRole("button", { name: "加密笔记", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "加密笔记", exact: true });
  await expect(dialog.getByLabel("密码", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByLabel("密码", { exact: true }).fill(passphrase);
  await dialog.getByLabel("确认密码", { exact: true }).fill(passphrase);
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "加密", exact: true }).click();
  await expect.poll(async () => await dialog.count() ? { alerts: await dialog.getByRole("alert").allTextContents(), buttons: await dialog.getByRole("button").allTextContents(), pending: await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("nowen-encryption-pending:"))), format: (await (await page.request.get(`${server}/api/notes/${original.id}`, { headers })).json()).contentFormat } : "converted", { timeout: 30_000 }).toBe("converted");
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "此笔记已加密", exact: true })).toBeVisible();
  const committed = await (await page.request.get(`${server}/api/notes/${original.id}/encryption/source`, { headers })).json();
  expect(committed.note.id).toBe(original.id); expect(committed.note.title).toBe(title); expect(committed.note.contentText).toBe("");
  expect(committed.note.contentFormat).toBe("encrypted-note-v2");
  expect(committed.history.some((row: { contentFormat: string }) => row.contentFormat === "encrypted-history-v2")).toBe(true);
  expect(committed.history.some((row: { id: string }) => /^[0-9a-f]{32}$/.test(row.id))).toBe(true);
  expect(JSON.stringify(committed)).not.toContain(marker); expect(JSON.stringify(committed)).not.toContain(historyMarker);
  expect(await page.evaluate(() => [...Object.keys(localStorage)].some((key) => key.startsWith("nowen-encryption-pending:")))).toBe(false);
  await page.getByLabel("密码", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  const editor = page.getByLabel(format === "markdown" ? "加密 Markdown 正文" : "加密富文本正文", { exact: true });
  await expect(editor).toBeVisible();
  if (format === "markdown") await expect(editor).toHaveValue(/CONVERSION_PRODUCT_BODY/);
  else await expect(editor).toContainText(marker);
  await page.getByRole("button", { name: "版本历史", exact: true }).click();
  await page.getByRole("button", { name: `版本 ${committed.note.version}`, exact: true }).click();
  await expect(page.getByRole("region", { name: "历史正文", exact: true })).toContainText(marker);
  await page.getByRole("button", { name: "关闭历史正文", exact: true }).click();
  const oldVersion = original.version;
  await page.getByRole("button", { name: `版本 ${oldVersion}`, exact: true }).click();
  const historyBody = page.getByRole("region", { name: "历史正文", exact: true });
  if (format === "markdown") await expect(historyBody).toContainText(historyMarker);
  else await expect(historyBody.getByLabel("加密富文本正文", { exact: true })).toBeEmpty();
  await page.getByRole("button", { name: "关闭历史正文", exact: true }).click();
  await page.getByRole("button", { name: `版本 ${beforeClear.version}`, exact: true }).click();
  await expect(page.getByRole("region", { name: "历史正文", exact: true })).toContainText(marker);
  await page.getByRole("button", { name: "关闭历史正文", exact: true }).click();
  await editor.fill(`${marker} edited`);
  await expect(page.getByRole("status").filter({ hasText: "已保存" })).toBeVisible();
  const saved = await (await page.request.get(`${server}/api/notes/${original.id}`, { headers })).json();
  expect(saved.contentFormat).toBe("encrypted-note-v2"); expect(saved.contentText).toBe(""); expect(saved.content).not.toContain(marker);
  await page.getByRole("button", { name: "锁定", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("region", { name: "历史正文", exact: true })).toHaveCount(0);
});
