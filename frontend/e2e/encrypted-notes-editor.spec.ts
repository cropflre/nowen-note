import type { EncryptedTestWindow } from "./encrypted-notes-runtime";
import { expect, test } from "./encrypted-notes-test";
import type { Page } from "@playwright/test";

const password = "test-only-m2-password";
const plaintext = "PRIVATE_ENCRYPTED_M2_SENTINEL";
async function create(page: Page, format = "markdown", clock = false) {
  await page.goto("http://127.0.0.1:5176/benchmarks/encrypted-notes-editor.html");
  if (clock) await page.clock.install();
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByLabel("加密笔记标题", { exact: true }).fill("Visible title");
  await page.getByLabel("加密笔记格式", { exact: true }).selectOption(format);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByLabel("确认密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
}
async function unlock(page: Page, passphrase = password) {
  await page.getByLabel("密码", { exact: true }).fill(passphrase);
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

test("locked notes show a simple password prompt at narrow and desktop widths", async ({ page }, testInfo) => {
  await create(page);
  const pane = page.getByLabel("加密笔记", { exact: true });
  await expect(pane.getByRole("heading", { name: "此笔记已加密", exact: true })).toBeVisible();
  await expect(pane.getByText("忘记密码将无法恢复内容。", { exact: true })).toBeVisible();
  await expect(pane.locator("details")).toHaveCount(0);
  await expect(pane.locator("textarea")).toHaveCount(0);
  await expect(pane.getByRole("button", { name: "解锁", exact: true })).toBeVisible();
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const bounds = await pane.locator("form").boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await pane.screenshot({ path: testInfo.outputPath(`locked-${width}.png`) });
  }
  await unlock(page);
  await expect(pane.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await expect(pane.getByRole("button", { name: "放弃修改并锁定", exact: true })).toHaveCount(0);
});

test("Markdown automatically saves, locks and rotates passwords with opaque persistence", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.includes("/api/notes") && ["POST", "PUT"].includes(request.method())) writes.push(request.postData() || ""); });
  await create(page); await unlock(page);
  const editor = page.getByLabel("加密 Markdown 正文", { exact: true });
  await editor.fill(plaintext);
  await expect(page.getByRole("status")).toHaveText("已保存");
  await assertNoLeaks(page);
  // Same-user token refresh must not discard an unlocked draft.
  await editor.fill(`${plaintext} unsaved`);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("nowen:token-changed")));
  await expect(editor).toHaveValue(`${plaintext} unsaved`);
  await page.getByRole("button", { name: "离开笔记", exact: true }).click();
  await expect(editor).toHaveValue(`${plaintext} unsaved`);
  await expect(page.getByRole("alert")).toContainText("等待保存");
  await expect(page.getByRole("status")).toHaveText("已保存");
  await page.getByRole("button", { name: "锁定", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await unlock(page, "wrong-test-password");
  await expect(page.getByRole("alert")).toContainText("密码错误或内容损坏");
  await unlock(page); await expect(editor).toHaveValue(`${plaintext} unsaved`);
  await page.getByText("修改密码", { exact: true }).click();
  await page.getByLabel("新密码", { exact: true }).fill("new-test-only-password");
  await page.getByLabel("确认新密码", { exact: true }).fill("new-test-only-password");
  await page.getByRole("button", { name: "确认修改", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已保存");
  await page.getByRole("button", { name: "锁定", exact: true }).click();
  await unlock(page); await expect(page.getByRole("alert")).toContainText("密码错误或内容损坏");
  await unlock(page, "new-test-only-password"); await expect(editor).toHaveValue(`${plaintext} unsaved`);
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
  await expect(page.getByRole("alert")).toContainText("原内容和当前修改已保留");
  expect(attempts).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.getByRole("alert")).toContainText("锁定未完成");
  await page.waitForTimeout(1200); expect(attempts).toBe(1);
  await expect(page.getByLabel("加密 Markdown 正文", { exact: true })).toHaveValue(plaintext);
  expect(await page.evaluate(() => window.encryptedFixtureState().activeNote!.content)).toBe(original);
  await assertNoLeaks(page);
  await page.getByRole("button", { name: "放弃修改并锁定", exact: true }).click();
});

test("offline saves persist ciphertext and recover after closing the editor and reloading", async ({ page }) => {
  await create(page); await unlock(page);
  await page.getByLabel("加密 Markdown 正文", { exact: true }).fill(plaintext);
  await page.route("**/api/notes/*", async (route) => route.request().method() === "PUT" ? route.abort("internetdisconnected") : route.continue());
  await expect(page.getByRole("status")).toHaveText("已保存");
  expect(await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("nowen-offline-queue:v2")).length)).toBe(1);
  await assertNoLeaks(page);
  await page.getByRole("button", { name: "锁定", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "恢复离线笔记", exact: true }).click();
  await unlock(page); await expect(page.getByLabel("加密 Markdown 正文", { exact: true })).toHaveValue(plaintext);
  await assertNoLeaks(page);
  await page.unroute("**/api/notes/*");
  await page.getByLabel("加密 Markdown 正文", { exact: true }).fill(`${plaintext} online`);
  await expect(page.getByRole("status")).toHaveText("已保存");
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
  await expect(page.getByRole("status")).toHaveText("已保存");
  await assertNoLeaks(page);
  await page.getByRole("button", { name: "锁定", exact: true }).click();
  await unlock(page); await expect(editor).toHaveText(plaintext);
  await expect(editor.locator("strong")).toHaveText(plaintext);
  await page.getByRole("button", { name: "锁定", exact: true }).click();
});

test("idle lock persists dirty ciphertext so a reload can recover it without a session draft", async ({ page }) => {
  await create(page, "markdown", true); await unlock(page);
  const editor = page.getByLabel("加密 Markdown 正文", { exact: true });
  await editor.fill(plaintext);
  const original = await page.evaluate(() => window.encryptedFixtureState().activeNote!.content);
  await page.clock.fastForward(5 * 60 * 1000 + 1);
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(await page.evaluate(() => window.encryptedFixtureState().activeNote!.content)).not.toBe(original);
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue(""); await assertNoLeaks(page);
  await page.reload(); await page.getByRole("button", { name: "恢复服务器笔记", exact: true }).click();
  await unlock(page, "wrong-test-password"); await expect(page.getByRole("alert")).toContainText("密码错误或内容损坏");
  await unlock(page); await expect(editor).toHaveValue(plaintext);
  await page.getByRole("button", { name: "锁定", exact: true }).click(); await assertNoLeaks(page);
});

test("background saves rich text before lock and a failed Worker preserves the latest document for retry", async ({ page }) => {
  await create(page, "tiptap-json"); await unlock(page);
  const editor = page.getByLabel("加密富文本正文", { exact: true }); await expect(editor).toBeVisible(); await editor.fill(plaintext);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(editor).toHaveCount(0); await expect(page.getByRole("status")).toHaveCount(0);
  await assertNoLeaks(page); await page.reload();
  await page.getByRole("button", { name: "恢复服务器笔记", exact: true }).click();
  await unlock(page); await expect(editor).toHaveText(plaintext);
  await editor.fill(`${plaintext} unsaved failure`);
  await page.evaluate(() => { (window as unknown as EncryptedTestWindow).__fixtureWorker = window.Worker; (window as unknown as EncryptedTestWindow).Worker = undefined; window.dispatchEvent(new Event("blur")); });
  await expect(page.getByRole("alert")).toContainText("锁定未完成");
  await expect(editor).toHaveText(`${plaintext} unsaved failure`);
  await page.evaluate(() => { window.Worker = (window as unknown as EncryptedTestWindow).__fixtureWorker!; delete (window as unknown as EncryptedTestWindow).__fixtureWorker; });
  await page.getByRole("button", { name: "重试锁定", exact: true }).click();
  await expect(editor).toHaveCount(0); await expect(page.getByRole("status")).toHaveCount(0);
  await page.reload(); await page.getByRole("button", { name: "恢复服务器笔记", exact: true }).click();
  await unlock(page); await expect(editor).toHaveText(`${plaintext} unsaved failure`);
  await page.getByRole("button", { name: "锁定", exact: true }).click(); await assertNoLeaks(page);
});

test("lock waits for an outstanding write and persists edits made during automatic saving", async ({ page }) => {
  await create(page); await unlock(page);
  const editor = page.getByLabel("加密 Markdown 正文", { exact: true });
  let writes = 0; let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/notes/*", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    if (++writes === 1) await delayed;
    await route.continue();
  });
  await editor.fill(plaintext);
  await expect.poll(() => writes).toBe(1);
  await expect(editor).toBeEditable(); await editor.fill(`${plaintext} newer`);
  await page.getByRole("button", { name: "锁定", exact: true }).click();
  await expect(editor).toHaveCount(0); expect(writes).toBe(1);
  await release(); await expect(page.getByRole("status")).toHaveCount(0); expect(writes).toBe(2);
  await page.reload(); await page.getByRole("button", { name: "恢复服务器笔记", exact: true }).click();
  await unlock(page); await expect(editor).toHaveValue(`${plaintext} newer`); await assertNoLeaks(page);
  await page.getByRole("button", { name: "锁定", exact: true }).click();
});
