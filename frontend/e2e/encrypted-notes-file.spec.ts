import { test, expect, encryptedFixtureUrl } from "./encrypted-notes-test";

const password = "test-only-m2-password";
const plaintext = "PRIVATE_ENCRYPTED_M2_SENTINEL file deployment";

test("file entry runs the bundled crypto Worker and WASM without a preview server", async ({ page }, testInfo) => {
  await page.goto(encryptedFixtureUrl("encrypted-notes.html"));
  expect(new URL(page.url()).protocol).toBe("file:");
  if (testInfo.project.name === "asar") expect(page.url()).toContain("/renderer.asar/");
  let closed = 0;
  page.on("worker", (worker) => {
    expect(new URL(worker.url()).protocol).toBe("file:");
    if (testInfo.project.name === "asar") expect(worker.url()).toContain("/renderer.asar/");
    worker.on("close", () => closed++);
  });
  await page.getByRole("button", { name: "运行核心自检" }).click();
  await expect(page.locator("#result")).toContainText('"status": "passed"');
  await expect.poll(() => closed).toBe(5);
  expect(await page.evaluate(() => ({ secure: isSecureContext, node: typeof (window as any).require, process: typeof (window as any).process })))
    .toEqual({ secure: true, node: "undefined", process: "undefined" });
});

for (const format of ["markdown", "tiptap-json"]) {
  test(`file ${format} saves through native HTTP, saves before locking and recovers server ciphertext after reload`, async ({ page, desktopApp }) => {
    await page.goto(encryptedFixtureUrl("encrypted-notes-editor.html"));
    expect(new URL(page.url()).protocol).toBe("file:");
    async function focus() {
      await desktopApp.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.show(); window.focus(); });
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    }
    await focus();
    await page.getByRole("button", { name: "新建", exact: true }).click();
    await page.getByLabel("加密笔记标题", { exact: true }).fill("Public file title");
    await page.getByLabel("加密笔记格式", { exact: true }).selectOption(format);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByLabel("确认密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    async function unlock(key = password) {
      await focus();
      await page.getByLabel("密码", { exact: true }).fill(key);
      await page.getByRole("button", { name: "解锁", exact: true }).click();
    }
    await unlock();
    const editor = page.getByLabel(format === "markdown" ? "加密 Markdown 正文" : "加密富文本正文", { exact: true });
    await expect(editor).toBeVisible(); await editor.fill(plaintext);
    await expect(page.getByRole("status")).toHaveText("已保存");
    const original = await page.evaluate(() => window.encryptedFixtureState().activeNote!.content);
    const draft = `${plaintext} unsaved`;
    await editor.fill(draft);
    await desktopApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await expect(editor).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveCount(0);
    expect(await page.evaluate(() => window.encryptedFixtureState().activeNote!.content)).not.toBe(original);
    await desktopApp.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await unlock("wrong-test-password"); await expect(page.getByRole("alert")).toContainText("密码错误或内容损坏");
    await unlock();
    if (format === "markdown") await expect(editor).toHaveValue(draft);
    else await expect(editor).toHaveText(draft);
    await page.getByRole("button", { name: "锁定", exact: true }).click();
    await page.reload(); await page.getByRole("button", { name: "恢复服务器笔记", exact: true }).click();
    await unlock();
    if (format === "markdown") await expect(editor).toHaveValue(draft);
    else await expect(editor).toHaveText(draft);
    await page.getByRole("button", { name: "锁定", exact: true }).click();
    const persisted = await page.evaluate(async () => {
      const rows: unknown[] = [Object.entries(localStorage), Object.entries(sessionStorage), window.encryptedFixtureState()];
      for (const database of await indexedDB.databases()) {
        if (!database.name) continue;
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(database.name!); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        for (const store of Array.from(db.objectStoreNames)) rows.push(await new Promise((resolve, reject) => {
          const request = db.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        }));
        db.close();
      }
      return JSON.stringify(rows);
    });
    expect(persisted).not.toContain(plaintext); expect(persisted).not.toContain(password);
    const requests = await desktopApp.evaluate(() => (globalThis as any).encryptedFixtureRequests as Array<{ method: string; body?: string }>);
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(2);
    expect(requests.some((request) => request.method === "GET")).toBe(true);
    expect(await (await page.request.get("http://127.0.0.1:5177/api/fixture/scan")).json()).toEqual({ leaks: [] });
  });
}
