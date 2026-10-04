import { test, expect } from "./encrypted-notes-app-test";

test("ordinary note actions hide internal conversion diagnostics while preflight stays read-only and owner-only", async ({ product }) => {
  const { page, server, app } = product;
  const password = "test-only-account-password";
  const registered = await page.request.post(`${server}/api/auth/register`, { data: { username: "preflight_user", password } });
  expect(registered.ok()).toBe(true);
  await page.getByPlaceholder("fnos.net/user:3001 或 192.168.1.10:3001", { exact: true }).fill(new URL(server).host);
  await page.getByPlaceholder("admin", { exact: true }).fill("preflight_user");
  await page.getByPlaceholder("••••••••", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await page.getByRole("button", { name: "在根目录新建", exact: true }).click();
  await page.getByRole("menuitem", { name: "Markdown 文档", exact: true }).click();
  await page.getByLabel("新内容名称", { exact: true }).fill("Public preflight product note");
  await page.getByRole("button", { name: "确认创建", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "笔记标题", exact: true })).toHaveValue("Public preflight product note");
  await expect(page.locator('[data-editor-more-menu="desktop"]')).toBeVisible();
  const readNote = () => page.evaluate(async (server) => {
    const headers = { Authorization: `Bearer ${localStorage.getItem("nowen-token")}` };
    const notes = await (await fetch(`${server}/api/notes`, { headers })).json();
    const note = notes.find((entry: { title: string }) => entry.title === "Public preflight product note");
    return await (await fetch(`${server}/api/notes/${note.id}`, { headers })).json();
  }, server);
  const before = await readNote();
  expect(await page.evaluate((id) => navigator.locks.request(`nowen-encrypted-conversion:v1:${encodeURIComponent(id)}`,
    { mode: "exclusive", ifAvailable: true }, (lock) => Boolean(lock)), before.id)).toBe(false);
  const otherRegistration = await page.request.post(`${server}/api/auth/register`, { data: { username: "preflight_other", password } });
  expect(otherRegistration.ok()).toBe(true);
  const otherAccount = await otherRegistration.json();
  const denied = await page.request.get(`${server}/api/notes/${before.id}/encryption-preflight`, { headers: { Authorization: `Bearer ${otherAccount.token}` } });
  expect([403, 404]).toContain(denied.status());
  await page.locator('[data-editor-more-menu="desktop"]').getByRole("button").first().click();
  await expect(page.getByRole("button", { name: "加密转换前检查", exact: true })).toHaveCount(0);
  const preflight = await page.evaluate(async ({ server, id }) => {
    const response = await fetch(`${server}/api/notes/${id}/encryption-preflight`, { headers: { Authorization: `Bearer ${localStorage.getItem("nowen-token")}` } });
    if (!response.ok) throw new Error("Internal preflight failed");
    return response.json();
  }, { server, id: before.id });
  expect(preflight.canConvert).toBe(false);
  expect(preflight.blockers).toContain("conversion_not_enabled");
  await page.keyboard.press("Escape");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes("/frontend/dist/index.html"))!.setContentSize(390, 844));
  await page.getByRole("button", { name: "更多", exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole("button", { name: "加密转换前检查", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const after = await readNote();
  expect({ content: after.content, format: after.contentFormat }).toEqual({ content: before.content, format: before.contentFormat });
});
