import { expect, test, encryptedFixtureUrl } from "./encrypted-notes-test";
const password = "test-only-m3-password";
const plaintext = "PRIVATE_ENCRYPTED_M3_SENTINEL actual editor";
for (const format of ["Markdown", "富文本"]) {
  test(`actual ${format} editor saves, converts and unlocks an opaque region`, async ({ page }) => {
    const errors: string[] = []; const writes: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (/5177\/api\/notes/.test(request.url()) && ["POST", "PUT"].includes(request.method())) writes.push(request.postData() || ""); });
    await page.goto(encryptedFixtureUrl("encrypted-notes-product-editor.html"));
    await page.getByRole("button", { name: `打开实际${format === "Markdown" ? " Markdown " : "富文本"}编辑器`, exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("编辑器就绪");
    const main = page.locator(format === "Markdown" ? ".cm-content" : ".tiptap").first();
    await expect(main).toBeVisible(); await main.focus();
    if (format === "Markdown") await page.getByRole("button", { name: "插入加密内容", exact: true }).click();
    else await page.locator('[title="插入加密内容"]').click();
    await expect(page.getByRole("dialog", { name: "局部加密区域", exact: true })).toBeVisible();
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByLabel("确认密码", { exact: true }).fill(password);
    await page.getByLabel("区域临时正文", { exact: true }).fill(plaintext);
    expect(await page.evaluate(() => window.productEditorDocument())).not.toContain(plaintext);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.productEditorDocument())).toContain("nowen-encrypted-v1");
    await page.getByRole("button", { name: "手动保存编辑器", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("实际编辑器保存已确认");
    if (format === "Markdown") {
      // Edit from preview without switching to source or locating a ciphertext fence.
      await page.locator('[title="markdown.view.preview"]').filter({ visible: true }).first().click();
      await expect(main).not.toBeVisible();
      await page.getByLabel("已锁定加密区域", { exact: true }).getByRole("button", { name: "解锁", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "局部加密区域", exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("密码", { exact: true }).fill(password);
      await dialog.getByLabel("密码", { exact: true }).press("Enter");
      await expect(dialog.getByLabel("区域临时正文", { exact: true })).toHaveValue(plaintext);
      await expect(dialog.getByLabel("密码", { exact: true })).toHaveCount(0);
      await dialog.getByLabel("区域临时正文", { exact: true }).fill(`${plaintext} preview edit`);
      expect(await page.evaluate(() => window.productEditorDocument())).not.toContain(plaintext);
      await dialog.getByRole("button", { name: "保存", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await page.getByRole("button", { name: "手动保存编辑器", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("实际编辑器保存已确认");
      // Restore the same text so the following format-conversion checks cover this saved envelope.
      await page.getByLabel("已锁定加密区域", { exact: true }).getByRole("button", { name: "解锁", exact: true }).click();
      await dialog.getByLabel("密码", { exact: true }).fill(password);
      await dialog.getByLabel("密码", { exact: true }).press("Enter");
      await expect(dialog.getByLabel("区域临时正文", { exact: true })).toHaveValue(`${plaintext} preview edit`);
      await dialog.getByLabel("区域临时正文", { exact: true }).fill(plaintext);
      await dialog.getByRole("button", { name: "保存", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await page.getByRole("button", { name: "手动保存编辑器", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("实际编辑器保存已确认");
    }
    await page.getByRole("button", { name: "切换实际编辑器格式", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("实际编辑器转换已确认");
    expect(await page.evaluate(() => window.productEditorDocument())).not.toContain(plaintext);
    // Return to the actual rich-text editor for the protected NodeView, in both directions.
    if (format === "富文本") {
      await page.getByRole("button", { name: "切换实际编辑器格式", exact: true }).click();
      await expect(page.locator(".tiptap")).toBeVisible();
    }
    await page.getByRole("button", { name: "解锁", exact: true }).first().click();
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("dialog", { name: "局部加密区域", exact: true }).getByRole("button", { name: "解锁", exact: true }).click();
    await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveValue(plaintext);
    expect(await page.evaluate(() => window.productEditorDocument())).not.toContain(plaintext);
    const edited = `${plaintext} edited`;
    await page.getByLabel("区域临时正文", { exact: true }).fill(edited);
    expect(await page.evaluate(() => window.productEditorDocument())).not.toContain(plaintext);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "手动保存编辑器", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("实际编辑器保存已确认");
    await page.getByRole("button", { name: "解锁", exact: true }).first().click();
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("dialog", { name: "局部加密区域", exact: true }).getByRole("button", { name: "解锁", exact: true }).click();
    await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveValue(edited);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    for (const body of writes) { expect(body).not.toContain(plaintext); expect(body).not.toContain(password); if (body.includes("nowen-encrypted")) expect(JSON.parse(body).encryptedBlocksVersion).toBe(1); }
    const scan = await page.request.get("http://127.0.0.1:5177/api/fixture/scan"); expect(await scan.json()).toEqual({ leaks: [] });
    expect(errors).toEqual([]);
  });
}
