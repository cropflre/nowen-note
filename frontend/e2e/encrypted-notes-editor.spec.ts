import { expect, test, type Page } from "@playwright/test";

const password = "test-only-m2-password";
const plaintext = "PRIVATE_ENCRYPTED_M2_SENTINEL";
async function create(page: Page, format = "markdown", clock = false) {
  await page.goto("/benchmarks/encrypted-notes-editor.html");
  if (clock) await page.clock.install();
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByLabel("加密笔记标题", { exact: true }).fill("Visible title");
  await page.getByLabel("加密笔记格式", { exact: true }).selectOption(format);
  await page.getByLabel("创建口令", { exact: true }).fill(password);
  await page.getByLabel("确认创建口令", { exact: true }).fill(password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "加密创建", exact: true }).click();
  await expect(page.getByLabel("解锁口令", { exact: true })).toBeVisible();
}
async function unlock(page: Page, passphrase = password) {
  await page.getByLabel("解锁口令", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "解锁", exact: true }).click();
}
async function assertNoLeaks(page: Page) {
  const persisted = await page.evaluate(async () => {
    const result: unknown[] = [Object.entries(localStorage), Object.entries(sessionStorage), window.encryptedFixtureState()];
    for (const database of await indexedDB.databases()) {
      if (!database.name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(database.name!);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const request = db.transaction(store).objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        result.push(rows);
      }
      db.close();
    }
    return JSON.stringify(result);
  });
  expect(persisted).not.toContain(plaintext); expect(persisted).not.toContain(password);
  const scan = await page.request.get("http://127.0.0.1:5177/api/fixture/scan");
  expect(await scan.json()).toEqual({ leaks: [] });
}

test("Markdown create, unlock, save, lock and password rotation keep all persistence opaque", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => { if (request.url().includes("5177/api/notes") && ["POST", "PUT"].includes(request.method())) writes.push(request.postData() || ""); });
  await create(page); await unlock(page);
  const editor = page.getByLabel("加密 Markdown 正文", { exact: true });
  await editor.fill(plaintext);
  await page.getByRole("button", { name: "加密保存", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("密文已由服务器确认保存");
  await assertNoLeaks(page);
  // Same-user token refresh must not discard an unlocked draft.
  await editor.fill(`${plaintext} unsaved`);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("nowen:token-changed")));
  await expect(editor).toHaveValue(`${plaintext} unsaved`);
  await page.getByRole("button", { name: "离开笔记", exact: true }).click();
  await expect(editor).toHaveValue(`${plaintext} unsaved`);
  await expect(page.getByRole("alert")).toContainText("请先保存密文");
  await page.getByRole("button", { name: "放弃修改并锁定", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await unlock(page, "wrong-test-password");
  await expect(page.getByRole("alert")).toContainText("口令错误或密文损坏");
  await unlock(page); await expect(editor).toHaveValue(plaintext);
  await page.locator("summary").click();
  await page.getByLabel("新口令", { exact: true }).fill("new-test-only-password");
  await page.getByLabel("确认新口令", { exact: true }).fill("new-test-only-password");
  await page.getByRole("button", { name: "确认改口令", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("密文已由服务器确认保存");
  await page.getByRole("button", { name: "锁定", exact: true }).click();
  await unlock(page); await expect(page.getByRole("alert")).toContainText("口令错误或密文损坏");
  await unlock(page, "new-test-only-password"); await expect(editor).toHaveValue(plaintext);
  await assertNoLeaks(page);
  for (const body of writes) { expect(body).not.toContain(plaintext); expect(body).not.toContain(password); expect(body).not.toContain("new-test-only-password"); expect(body).toContain("encrypted-note-v1"); }
});

test("conflict keeps the unsaved body and original ciphertext without an automatic retry", async ({ page }) => {
  await create(page); await unlock(page);
  const original = await page.evaluate(() => window.encryptedFixtureState().activeNote!.content);
  await page.getByLabel("加密 Markdown 正文", { exact: true }).fill(plaintext);
  let attempts = 0;
  await page.route("**/api/notes/*", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    attempts++; await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "VERSION_CONFLICT", error: "Test conflict" }) });
  });
  await page.getByRole("button", { name: "加密保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("原密文和当前修改已保留");
  expect(attempts).toBe(1);
  await expect(page.getByLabel("加密 Markdown 正文", { exact: true })).toHaveValue(plaintext);
  expect(await page.evaluate(() => window.encryptedFixtureState().activeNote!.content)).toBe(original);
  await assertNoLeaks(page);
  await page.getByRole("button", { name: "放弃修改并锁定", exact: true }).click();
});

test("offline saves persist ciphertext and recover after closing the editor and reloading", async ({ page }) => {
  await create(page); await unlock(page);
  await page.getByLabel("加密 Markdown 正文", { exact: true }).fill(plaintext);
  await page.route("**/api/notes/*", async (route) => route.request().method() === "PUT" ? route.abort("internetdisconnected") : route.continue());
  await page.getByRole("button", { name: "加密保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("离线队列");
  await assertNoLeaks(page);
  await page.getByRole("button", { name: "锁定", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "恢复离线笔记", exact: true }).click();
  await unlock(page); await expect(page.getByLabel("加密 Markdown 正文", { exact: true })).toHaveValue(plaintext);
  await assertNoLeaks(page);
  await page.unroute("**/api/notes/*");
  await page.getByLabel("加密 Markdown 正文", { exact: true }).fill(`${plaintext} online`);
  await page.getByRole("button", { name: "加密保存", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("密文已由服务器确认保存");
  expect(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("nowen-offline-queue:v2")).length)).toBe(0);
  await page.getByRole("button", { name: "锁定", exact: true }).click();
});

test("rich-text editor preserves basic text formatting in the encrypted payload", async ({ page }) => {
  await create(page, "tiptap-json"); await unlock(page);
  const editor = page.getByLabel("加密富文本正文", { exact: true });
  await expect(editor).toBeVisible();
  await editor.fill(plaintext);
  await editor.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "加粗", exact: true }).click();
  await expect(editor.locator("strong")).toHaveText(plaintext);
  await page.getByRole("button", { name: "加密保存", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("密文已由服务器确认保存");
  await assertNoLeaks(page);
  await page.getByRole("button", { name: "锁定", exact: true }).click();
  await unlock(page); await expect(editor).toHaveText(plaintext);
  await expect(editor.locator("strong")).toHaveText(plaintext);
  await page.getByRole("button", { name: "锁定", exact: true }).click();
});

test("idle auto-lock seals a dirty draft in memory and restores it only after password entry", async ({ page }) => {
  await create(page, "markdown", true); await unlock(page);
  const editor = page.getByLabel("加密 Markdown 正文", { exact: true });
  await editor.fill(plaintext);
  const original = await page.evaluate(() => window.encryptedFixtureState().activeNote!.content);
  await page.clock.fastForward(5 * 60 * 1000 + 1);
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("重新解锁可恢复");
  expect(await page.evaluate(() => window.encryptedFixtureState().activeNote!.content)).toBe(original);
  await expect(page.getByLabel("解锁口令", { exact: true })).toHaveValue(""); await assertNoLeaks(page);
  await unlock(page, "wrong-test-password"); await expect(page.getByRole("alert")).toContainText("口令错误或密文损坏");
  await unlock(page); await expect(editor).toHaveValue(plaintext);
  await page.getByRole("button", { name: "加密保存", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("密文已由服务器确认保存");
  await page.getByRole("button", { name: "锁定", exact: true }).click(); await unlock(page);
  await expect(editor).toHaveValue(plaintext); await assertNoLeaks(page);
});

test("window background removes the real rich-text editor and restores its unsaved encrypted draft", async ({ page }) => {
  await create(page, "tiptap-json"); await unlock(page);
  const editor = page.getByLabel("加密富文本正文", { exact: true }); await expect(editor).toBeVisible(); await editor.fill(plaintext);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(editor).toHaveCount(0); await expect(page.getByRole("status")).toContainText("重新解锁可恢复");
  await assertNoLeaks(page); await unlock(page); await expect(editor).toHaveText(plaintext);
  await page.getByRole("button", { name: "加密保存", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("密文已由服务器确认保存");
  // A failed seal must remount the latest rich-text document, including edits,
  // rather than the original editor seed.
  await editor.fill(`${plaintext} unsaved failure`);
  await page.evaluate(() => { (window as any).__fixtureWorker = window.Worker; (window as any).Worker = undefined; window.dispatchEvent(new Event("blur")); });
  await expect(page.getByRole("alert")).toContainText("自动锁定未完成");
  await expect(editor).toHaveText(`${plaintext} unsaved failure`);
  await page.evaluate(() => { window.Worker = (window as any).__fixtureWorker; delete (window as any).__fixtureWorker; });
  await page.getByRole("button", { name: "重试自动锁定", exact: true }).click();
  await expect(editor).toHaveCount(0); await expect(page.getByRole("status")).toContainText("重新解锁可恢复");
  await unlock(page); await expect(editor).toHaveText(`${plaintext} unsaved failure`);
  await page.getByRole("button", { name: "加密保存", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("密文已由服务器确认保存");
  await page.getByRole("button", { name: "锁定", exact: true }).click();
});
