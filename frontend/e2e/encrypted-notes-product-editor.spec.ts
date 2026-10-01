import { expect, test } from "@playwright/test";
const password = "test-only-m3-password";
const plaintext = "PRIVATE_ENCRYPTED_M3_SENTINEL actual editor";
for (const format of ["Markdown", "富文本"]) {
  test(`actual ${format} editor saves, converts and unlocks an opaque region`, async ({ page }) => {
    const errors: string[] = []; const writes: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (/5177\/api\/notes/.test(request.url()) && ["POST", "PUT"].includes(request.method())) writes.push(request.postData() || ""); });
    await page.goto("/benchmarks/encrypted-notes-product-editor.html");
    await page.getByRole("button", { name: `打开实际${format === "Markdown" ? " Markdown " : "富文本"}编辑器`, exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("编辑器就绪");
    const main = page.locator(format === "Markdown" ? ".cm-content" : ".tiptap").first();
    await expect(main).toBeVisible(); await main.focus();
    if (format === "Markdown") await page.getByRole("button", { name: "加密区域（实验性）", exact: true }).click();
    else await page.locator('[title="新增加密区域（实验性）"]').click();
    await expect(page.getByRole("dialog", { name: "局部加密区域", exact: true })).toBeVisible();
    await page.getByLabel("区域口令", { exact: true }).fill(password);
    await page.getByLabel("确认区域口令", { exact: true }).fill(password);
    await page.getByRole("checkbox").check();
    await page.getByLabel("区域临时正文", { exact: true }).fill(plaintext);
    expect(await page.evaluate(() => window.productEditorDocument())).not.toContain(plaintext);
    await page.getByRole("button", { name: "加密写回", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.productEditorDocument())).toContain("nowen-encrypted-v1");
    await page.getByRole("button", { name: "手动保存编辑器", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("实际编辑器保存已确认");
    await page.getByRole("button", { name: "切换实际编辑器格式", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("实际编辑器转换已确认");
    expect(await page.evaluate(() => window.productEditorDocument())).not.toContain(plaintext);
    // Return to the actual rich-text editor for the protected NodeView, in both directions.
    if (format === "富文本") {
      await page.getByRole("button", { name: "切换实际编辑器格式", exact: true }).click();
      await expect(page.locator(".tiptap")).toBeVisible();
    }
    await page.getByRole("button", { name: "查看加密区域", exact: true }).first().click();
    await page.getByLabel("区域口令", { exact: true }).fill(password);
    await page.getByRole("button", { name: "解锁区域", exact: true }).click();
    await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveValue(plaintext);
    expect(await page.evaluate(() => window.productEditorDocument())).not.toContain(plaintext);
    const edited = `${plaintext} edited`;
    await page.getByLabel("区域临时正文", { exact: true }).fill(edited);
    expect(await page.evaluate(() => window.productEditorDocument())).not.toContain(plaintext);
    await page.getByRole("button", { name: "加密写回", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "手动保存编辑器", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("实际编辑器保存已确认");
    await page.getByRole("button", { name: "查看加密区域", exact: true }).first().click();
    await page.getByLabel("区域口令", { exact: true }).fill(password);
    await page.getByRole("button", { name: "解锁区域", exact: true }).click();
    await expect(page.getByLabel("区域临时正文", { exact: true })).toHaveValue(edited);
    await page.getByRole("button", { name: "关闭并锁定", exact: true }).click();
    for (const body of writes) { expect(body).not.toContain(plaintext); expect(body).not.toContain(password); if (body.includes("nowen-encrypted")) expect(JSON.parse(body).encryptedBlocksVersion).toBe(1); }
    const scan = await page.request.get("http://127.0.0.1:5177/api/fixture/scan"); expect(await scan.json()).toEqual({ leaks: [] });
    expect(errors).toEqual([]);
  });
}
