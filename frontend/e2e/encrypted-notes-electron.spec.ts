import type { EncryptedTestWindow } from "./encrypted-notes-runtime";
import { expect, test } from "./encrypted-notes-test";

const password = "test-only-m2-password";
const plaintext = "PRIVATE_ENCRYPTED_M2_SENTINEL native window draft";

test.beforeEach(async ({ page, desktopApp }) => {
  await page.goto("http://127.0.0.1:5176/benchmarks/encrypted-notes-editor.html");
  await desktopApp.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus();
  });
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  expect(await page.evaluate(() => ({
    node: typeof (window as unknown as EncryptedTestWindow).require, process: typeof (window as unknown as EncryptedTestWindow).process,
    desktop: (window as unknown as EncryptedTestWindow).nowenDesktop?.isDesktop, secure: isSecureContext,
  }))).toEqual({ node: "undefined", process: "undefined", desktop: true, secure: true });
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByLabel("加密笔记标题", { exact: true }).fill("Public native title");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByLabel("确认密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
  await page.getByLabel("加密 Markdown 正文", { exact: true }).fill(plaintext);
});

for (const event of ["hide", "blur", "minimize"] as const) {
  test(`native window ${event} locks the editor and persists ciphertext before locking`, async ({ page, desktopApp }, testInfo) => {
    await testInfo.attach("electron-runtime.json", {
      body: JSON.stringify(await desktopApp.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch }))),
      contentType: "application/json",
    });
    const writes: string[] = [];
    page.on("request", (request) => { if (request.url().includes("5177/api/notes") && request.method() === "PUT") writes.push(request.postData() || ""); });
    const original = await page.evaluate(() => window.encryptedFixtureState().activeNote!.content);
    const mainId = await desktopApp.evaluate(({ BrowserWindow }, event) => {
      const main = BrowserWindow.getAllWindows()[0];
      if (event === "hide") main.hide();
      else if (event === "minimize") main.minimize();
      else {
        const other = new BrowserWindow({ width: 200, height: 150, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
        other.focus();
      }
      return main.id;
    }, event);
    await expect(page.getByLabel("加密 Markdown 正文", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByLabel("密码", { exact: true })).toHaveValue("");
    expect(writes).toHaveLength(1);
    expect(await page.evaluate(() => window.encryptedFixtureState().activeNote!.content)).not.toBe(original);
    expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), window.encryptedFixtureState()]))).not.toContain(plaintext);
    await desktopApp.evaluate(({ BrowserWindow }, mainId) => {
      for (const other of BrowserWindow.getAllWindows()) if (other.id !== mainId) other.destroy();
      const main = BrowserWindow.fromId(mainId)!; main.restore(); main.show(); main.focus();
    }, mainId);
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "解锁", exact: true }).click();
    await expect(page.getByLabel("加密 Markdown 正文", { exact: true })).toHaveValue(plaintext);
    expect(writes).toHaveLength(1); expect(writes[0]).not.toContain(plaintext); expect(writes[0]).not.toContain(password);
    expect(await (await page.request.get("http://127.0.0.1:5177/api/fixture/scan")).json()).toEqual({ leaks: [] });
    await page.getByRole("button", { name: "锁定", exact: true }).click();
  });
}
