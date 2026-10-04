import { test, expect, forbidden } from "./encrypted-notes-app-test";
import type { Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const passphrase = forbidden[1];
const plaintext = `${forbidden[0]} saved`;
const accountPassword = "test-only-account-password";

async function login(page: Page, username: string, server: string) {
  await page.getByPlaceholder("fnos.net/user:3001 或 192.168.1.10:3001", { exact: true }).fill(new URL(server).host);
  await page.getByPlaceholder("admin", { exact: true }).fill(username);
  await page.getByPlaceholder("••••••••", { exact: true }).fill(accountPassword);
  await page.getByRole("button", { name: "登录工作台", exact: true }).click();
  await expect(page.getByRole("button", { name: "在根目录新建", exact: true })).toBeVisible();
}

async function switchAccount(page: Page, username: string) {
  await page.getByRole("button", { name: "登录过的账号", exact: true }).click();
  await page.getByRole("dialog", { name: "登录过的账号", exact: true }).getByRole("button").filter({ hasText: `@${username}` }).click();
  await expect(page.getByRole("button", { name: "在根目录新建", exact: true })).toBeVisible();
}

for (const format of ["markdown", "tiptap-json"]) {
test(`full AppShell autosaves encrypted ${format}, persists on background and clears its session on ${format === "markdown" ? "logout" : "account switch"}`, async ({ product }) => {
  const { page, server, app } = product;
  const registered = await page.request.post(`${server}/api/auth/register`, { data: { username: "encryption_a", password: accountPassword } });
  expect(registered.ok()).toBe(true);
  await login(page, "encryption_a", server);
  if (format === "tiptap-json") {
    const response = await page.request.post(`${server}/api/auth/register`, { data: { username: "encryption_b", password: accountPassword } });
    expect(response.ok()).toBe(true); const account = await response.json();
    // Seed a valid recent login using the real secure-storage IPC, then switch via UI.
    expect(await page.evaluate(async ({ server, account }) => (window as any).nowenDesktop.accountHistory.save({
      serverUrl: server, userId: account.user.id, username: account.user.username, displayName: "", avatarUrl: "", token: account.token, refreshToken: account.refreshToken, lastUsedAt: Date.now(),
    }), { server, account })).toMatchObject({ ok: true });
  }
  await page.getByRole("button", { name: "在根目录新建", exact: true }).click();
  await page.getByRole("menuitem", { name: "加密笔记", exact: true }).click();
  await page.getByLabel("加密笔记标题", { exact: true }).fill("Public encrypted product note");
  await page.getByLabel("加密笔记格式", { exact: true }).selectOption(format);
  await page.getByLabel("密码", { exact: true }).fill(passphrase);
  await page.getByLabel("确认密码", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  async function unlock() {
    await page.getByLabel("密码", { exact: true }).fill(passphrase);
    await page.getByRole("button", { name: "解锁", exact: true }).click();
  }
  await unlock();
  const editor = page.getByLabel(format === "markdown" ? "加密 Markdown 正文" : "加密富文本正文", { exact: true });
  await expect(editor).toBeVisible(); await editor.fill(plaintext);
  await expect(page.getByRole("status").filter({ hasText: "已保存" })).toBeVisible();
  await editor.fill(`${forbidden[0]} unsaved draft`);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window: { webContents: { getURL(): string } }) => window.webContents.getURL().includes("/frontend/dist/index.html"))!.hide());
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "已锁定，修改已保存" })).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find((entry: { webContents: { getURL(): string } }) => entry.webContents.getURL().includes("/frontend/dist/index.html"))!; window.show(); window.focus(); });
  if (format === "markdown") {
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.getByPlaceholder("admin", { exact: true })).toBeVisible();
    await login(page, "encryption_a", server);
  } else {
    const noteId = await page.evaluate(async (server) => {
      const notes = await (await fetch(`${server}/api/notes`, { headers: { Authorization: `Bearer ${localStorage.getItem("nowen-token")}`, Accept: "application/json" } })).json();
      return notes.find((note: { title: string }) => note.title === "Public encrypted product note").id as string;
    }, server);
    await switchAccount(page, "encryption_b");
    await expect(page.getByText("Public encrypted product note", { exact: true })).toHaveCount(0);
    const status = await page.evaluate(async ({ server, noteId }) => (await fetch(`${server}/api/notes/${noteId}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("nowen-token")}`, Accept: "application/json" },
    })).status, { server, noteId });
    expect([403, 404]).toContain(status);
    await switchAccount(page, "encryption_a");
  }
  await page.getByText("Public encrypted product note", { exact: true }).first().click();
  await unlock();
  if (format === "markdown") await expect(editor).toHaveValue(`${forbidden[0]} unsaved draft`);
  else await expect(editor).toHaveText(`${forbidden[0]} unsaved draft`);
  await page.getByRole("button", { name: "锁定", exact: true }).click();
});
}

for (const format of ["markdown", "tiptap-json"]) {
test(`full ${format} region editor clears unsaved plaintext on a real cross-window logout`, async ({ product }) => {
  const { page, app, server, directory } = product;
  const registered = await page.request.post(`${server}/api/auth/register`, { data: { username: "encryption_a", password: accountPassword } });
  expect(registered.ok()).toBe(true);
  await login(page, "encryption_a", server);
  await page.getByRole("button", { name: "在根目录新建", exact: true }).click();
  await page.getByRole("menuitem", { name: format === "markdown" ? "Markdown 文档" : "富文本文档", exact: true }).click();
  await page.getByLabel("新内容名称", { exact: true }).fill("Public region product note");
  await page.getByRole("button", { name: "确认创建", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "笔记标题", exact: true })).toHaveValue("Public region product note");
  const token = await page.evaluate(() => localStorage.getItem("nowen-token"));
  const notes = await (await page.request.get(`${server}/api/notes`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const note = notes.find((entry: { title: string }) => entry.title === "Public region product note"); expect(note).toBeTruthy();
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
  await expect(page.getByRole("dialog", { name: "局部加密区域", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await (await page.request.get(`${server}/api/notes/${note.id}`, { headers: { Authorization: `Bearer ${token}` } })).json()).content).toContain("nowen-encrypted-v1");
  async function viewRegion() {
    if (format === "markdown") {
      await page.getByRole("button", { name: "源码", exact: true }).click();
      await main.focus(); await page.keyboard.press("ControlOrMeta+Home");
      await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown");
      await openRegion();
    } else await page.getByRole("button", { name: "解锁", exact: true }).first().click();
    await page.getByLabel("密码", { exact: true }).fill(passphrase);
    await page.getByRole("dialog", { name: "局部加密区域", exact: true }).getByRole("button", { name: "解锁", exact: true }).click();
  }
  await viewRegion();
  await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveValue(plaintext);
  await page.getByLabel("区域临时正文", { exact: true }).fill(`${forbidden[0]} unsaved region`);
  // A real same-origin storage event, as emitted by another client's logout broadcast.
  const logoutFile = path.join(directory, "logout.html"); fs.writeFileSync(logoutFile, "<!doctype html><title>Private logout window</title>");
  const shared = await app.evaluate(async ({ BrowserWindow }, file) => {
    const other = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    try {
      await other.loadFile(file);
      return await other.webContents.executeJavaScript(`(() => { const shared = !!localStorage.getItem('nowen-token'); localStorage.removeItem('nowen-token'); localStorage.removeItem('nowen-refresh-token'); localStorage.setItem('nowen-logout-broadcast', String(Date.now())); return shared; })()`);
    } finally { other.destroy(); }
  }, logoutFile);
  expect(shared).toBe(true);
  await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "局部加密区域", exact: true })).toHaveCount(0);
  await login(page, "encryption_a", server);
  await page.getByText("Public region product note", { exact: true }).first().click();
  if (format === "tiptap-json") await expect(main).toBeVisible();
  else await expect(page.getByRole("button", { name: "源码", exact: true })).toBeVisible();
  await viewRegion();
  await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveValue(plaintext);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
});
}

test("production native HTTP rejects invalid requests and other windows, and enforces backend auth", async ({ product }) => {
  const { page, app, server } = product;
  const response = await page.evaluate(async (server) => {
    const http = (window as any).nowenDesktop.http;
    const request = (url: string, method = "GET") => http.requestJson({ url, method, headers: { Accept: "application/json" } });
    return {
      path: await request(`${server}/outside-api`),
      protocol: await request("file:///api/notes"),
      method: await request(`${server}/api/notes`, "TRACE"),
      auth: await request(`${server}/api/notes`),
      headers: await http.requestJson({ url: `${server}/api/health?header-filter`, method: "GET", headers: {
        Host: "forbidden-header-marker", Origin: "forbidden-header-marker", Cookie: "forbidden-header-marker", "Sec-Fetch-Site": "forbidden-header-marker", "X-Encrypted-Test": "retained",
      } }),
    };
  }, server);
  expect(response.path).toMatchObject({ ok: false, error: "INVALID_API_URL" });
  expect(response.protocol).toMatchObject({ ok: false, error: "INVALID_API_URL" });
  expect(response.method).toMatchObject({ ok: false, error: "INVALID_METHOD" });
  expect(response.auth).toMatchObject({ ok: true, status: 401 });
  expect(response.headers).toMatchObject({ ok: true, status: 200 });
  const headers = await app.evaluate(() => (globalThis as any).encryptedAppHeaders.find((request: { url: string }) => request.url.endsWith("/api/health?header-filter")).headers as Record<string, string>);
  expect(JSON.stringify(headers)).not.toContain("forbidden-header-marker");
  expect(Object.entries(headers).some(([name, value]) => name.toLowerCase() === "x-encrypted-test" && value === "retained")).toBe(true);
  const rejected = await app.evaluate(async ({ BrowserWindow }, { server, preload }) => {
    const main = BrowserWindow.getAllWindows().find((window: { webContents: { getURL(): string } }) => window.webContents.getURL().includes("/frontend/dist/index.html"))!;
    const other = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, preload } });
    try {
      await other.loadURL(main.webContents.getURL());
      return await other.webContents.executeJavaScript(`window.nowenDesktop.http.requestJson(${JSON.stringify({ url: `${server}/api/health`, headers: {}, method: "GET" })})`);
    } finally { other.destroy(); }
  }, { server, preload: path.resolve("../electron/preload.js") });
  expect(rejected).toMatchObject({ ok: false, error: "UNTRUSTED_SENDER" });
});
