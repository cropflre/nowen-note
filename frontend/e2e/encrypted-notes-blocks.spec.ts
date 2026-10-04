import { expect, test } from "./encrypted-notes-test";
import type { Page } from "@playwright/test";
const password = "test-only-m3-password";
const plaintext = "PRIVATE_ENCRYPTED_M3_SENTINEL";
async function create(page: Page) {
  await page.goto("http://127.0.0.1:5176/benchmarks/encrypted-notes-blocks.html");
  await page.getByRole("button", { name: "载入普通笔记", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已载入");
  await page.getByRole("button", { name: "新增加密区域", exact: true }).click();
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByLabel("确认密码", { exact: true }).fill(password);
  await page.getByLabel("区域临时正文", { exact: true }).fill(plaintext);
  expect(await page.evaluate(() => window.blockFixtureDocument())).not.toContain(plaintext);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("已锁定加密区域", { exact: true })).toHaveCount(1);
}
async function unlock(page: Page, value = password) {
  await page.getByLabel("已锁定加密区域", { exact: true }).getByRole("button", { name: "解锁", exact: true }).click();
  await page.getByLabel("密码", { exact: true }).fill(value);
  await page.getByRole("dialog", { name: "局部加密区域", exact: true }).getByRole("button", { name: "解锁", exact: true }).click();
}
async function noLeaks(page: Page) {
  const persisted = await page.evaluate(async () => {
    const rows: unknown[] = [Object.entries(localStorage), Object.entries(sessionStorage), window.blockFixtureDocument()];
    for (const entry of await indexedDB.databases()) {
      if (!entry.name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(entry.name!); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      for (const store of Array.from(db.objectStoreNames)) rows.push(await new Promise((resolve, reject) => { const request = db.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }));
      db.close();
    }
    return JSON.stringify(rows);
  });
  expect(persisted).not.toContain(plaintext); expect(persisted).not.toContain(password);
  expect(await (await page.request.get("http://127.0.0.1:5177/api/fixture/scan")).json()).toEqual({ leaks: [] });
}
test("real worker, editor history, format conversion, clipboard and persistence retain only ciphertext", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", (request) => { if (/5177\/api\/notes/.test(request.url()) && ["POST", "PUT"].includes(request.method())) writes.push(request.postData() || ""); });
  await create(page);
  const original = await page.evaluate(() => window.blockFixtureDocument());
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.getByLabel("已锁定加密区域", { exact: true })).toHaveCount(0);
  await noLeaks(page);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  expect(await page.evaluate(() => window.blockFixtureDocument())).toBe(original);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (value: string) => { sessionStorage.setItem("fixture-cipher-copy", value); return Promise.resolve(); } } }); });
  await page.getByRole("button", { name: "复制加密内容", exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("fixture-cipher-copy"))).toContain("```nowen-encrypted-v1");
  await page.getByRole("button", { name: "转换格式", exact: true }).click();
  await expect(page.getByLabel("主文档 Markdown 密文", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存主文档", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("服务器已保存密文");
  await page.reload(); await page.getByRole("button", { name: "载入普通笔记", exact: true }).click();
  await expect(page.getByLabel("已锁定加密区域", { exact: true })).toHaveCount(1);
  await unlock(page, "wrong-password");
  await expect(page.getByRole("alert")).toContainText("操作失败");
  await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveCount(0);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("dialog", { name: "局部加密区域", exact: true }).getByRole("button", { name: "解锁", exact: true }).click();
  await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveValue(plaintext);
  await noLeaks(page);
  await page.getByLabel("区域临时正文", { exact: true }).fill(`${plaintext} edited`);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "保存主文档", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("服务器已保存密文");
  await page.getByRole("button", { name: "只读", exact: true }).click();
  await unlock(page); await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveValue(`${plaintext} edited`);
  await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveAttribute("readonly", "");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await noLeaks(page);
  for (const body of writes) { expect(body).not.toContain(plaintext); expect(body).not.toContain(password); }
});
test("failed region writes keep private draft and do not replace a changed document", async ({ page }) => {
  await page.goto("http://127.0.0.1:5176/benchmarks/encrypted-notes-blocks.html");
  await page.getByRole("button", { name: "载入普通笔记", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已载入");
  await page.getByRole("button", { name: "新增加密区域", exact: true }).click();
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByLabel("确认密码", { exact: true }).fill(password);
  await page.getByLabel("区域临时正文", { exact: true }).fill(plaintext);
  await page.getByRole("button", { name: "外部修改", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("操作失败");
  await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveValue(plaintext);
  await expect(page.getByLabel("已锁定加密区域", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.blockFixtureDocument())).toContain("public change");
  await noLeaks(page);
  const prevented = await page.evaluate(() => !window.dispatchEvent(new Event("nowen:encrypted-note-before-leave", { cancelable: true })));
  expect(prevented).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("an external region update cannot retarget an unlocked session or discard its private draft", async ({ page }) => {
  await create(page); await unlock(page);
  await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveValue(plaintext);
  await page.getByLabel("区域临时正文", { exact: true }).fill(`${plaintext} unsaved`);
  await page.getByRole("button", { name: "修改区域密文", exact: true }).click();
  const changed = await page.evaluate(() => window.blockFixtureDocument());
  await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveValue(`${plaintext} unsaved`);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("操作失败");
  expect(await page.evaluate(() => window.blockFixtureDocument())).toBe(changed);
  await noLeaks(page);
  await page.evaluate(() => { localStorage.setItem("nowen-token", `test.${btoa(JSON.stringify({ userId: "other-fixture-owner" }))}.test`); window.dispatchEvent(new CustomEvent("nowen:token-changed")); });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveCount(0);
});

test("background auto-lock preserves a region draft as memory ciphertext without changing the main document", async ({ page }) => {
  await create(page); await unlock(page);
  const editor = page.getByLabel("区域临时正文", { exact: true }); await expect(editor).toHaveValue(plaintext);
  await editor.fill(`${plaintext} unsaved`);
  const original = await page.evaluate(() => window.blockFixtureDocument());
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("重新解锁可恢复");
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue("");
  expect(await page.evaluate(() => window.blockFixtureDocument())).toBe(original); await noLeaks(page);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("dialog", { name: "局部加密区域", exact: true }).getByRole("button", { name: "解锁", exact: true }).click(); await expect(editor).toHaveValue(`${plaintext} unsaved`);
  await page.getByRole("button", { name: "保存", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "保存主文档", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("服务器已保存密文"); await noLeaks(page);
});
