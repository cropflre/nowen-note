import { test, expect } from "@playwright/test";
import fs from "node:fs";

for (const format of ["tiptap-json", "markdown"] as const) {
  for (const failure of ["network", "invalid-json"] as const) {
    test(`${format}: persisted PDF survives a lost ${failure} response and reopens without duplicate upload`, async ({ page, request }) => {
      const login = await request.post("/api/auth/login", { data: { username: "assets_qa", password: "assets-qa-only-password" } });
      expect(login.ok()).toBe(true);
      const account = await login.json();
      const headers = { Authorization: `Bearer ${account.token}` };
      const title = `Issue 894 ${format} ${failure}`;
      const noteResponse = await request.post("/api/notes", { headers, data: {
        notebookId: "assets-qa-notebook", title, contentFormat: format,
        content: format === "markdown" ? "| 型号 | 尺寸 |\n|---|---|\n|林内|725 x 400 x 350 mm|\n\n" : JSON.stringify({ type: "doc", content: [
          { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "已有表格" }] }] }] }] },
          { type: "paragraph" },
        ] }),
      } });
      expect(noteResponse.ok()).toBe(true);
      const note = await noteResponse.json();
      await page.addInitScript((tokens) => {
        localStorage.setItem("nowen-token", tokens.token);
        localStorage.setItem("nowen-refresh-token", tokens.refreshToken);
        localStorage.setItem("i18nextLng", "zh-CN");
        localStorage.setItem("nowen-seen-version", tokens.version);
      }, { ...account, version: JSON.parse(fs.readFileSync("../package.json", "utf8")).version });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto("/");
      await page.getByRole("button", { name: title, exact: true }).click();
      const editor = page.locator(format === "markdown" ? '.cm-content[contenteditable="true"]' : '.tiptap[contenteditable="true"]');
      await editor.click();
      await page.keyboard.press("ControlOrMeta+End");
      let uploads = 0;
      let uploadedId = "";
      await page.route("**/api/attachments**", async (route) => {
        if (route.request().method() !== "POST" || !new URL(route.request().url()).pathname.endsWith("/api/attachments")) return route.continue();
        uploads++;
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        uploadedId = (await response.json()).id;
        if (failure === "network") await route.abort("failed");
        else await route.fulfill({ status: 201, contentType: "application/json", body: "truncated-json" });
      });
      await page.getByRole("button", { name: "上传新附件", exact: true }).click();
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("menuitem", { name: "上传新附件", exact: true }).click();
      const bytes = Buffer.concat([Buffer.from(`%PDF-1.4\n${format} ${failure}\n`), Buffer.alloc(3_400_000, 65)]);
      await (await chooser).setFiles({ name: "菲斯曼A1JE宣传册.pdf", mimeType: "application/pdf", buffer: bytes });
      await expect(page.getByText("附件上传成功", { exact: true })).toBeVisible();
      await expect(page.getByText("附件上传失败", { exact: true })).toBeHidden();
      await expect.poll(async () => (await (await request.get(`/api/notes/${note.id}`, { headers })).json()).content).toContain("/api/attachments/");
      expect(uploadedId).not.toBe("");
      expect((await request.get(`/api/attachments/upload-result/${uploadedId}?noteId=${note.id}`)).status()).toBe(401);
      const saved = await (await request.get(`/api/notes/${note.id}`, { headers })).json();
      expect(saved.content).toContain(`/api/attachments/${uploadedId}`);
      expect(uploads).toBe(1);
      const files = await (await request.get(`/api/files?noteId=${note.id}`, { headers })).json();
      expect(files.items).toHaveLength(1);
      expect(files.items[0].id).toBe(uploadedId);
      expect(await (await request.get(files.accessUrls[uploadedId])).body()).toEqual(bytes);
      await page.reload();
      await expect(editor).toContainText("菲斯曼A1JE宣传册.pdf");
      expect(pageErrors).toEqual([]);
    });
  }
}
