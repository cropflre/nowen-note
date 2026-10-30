import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const evidence = path.resolve("../docs/qa/files-assets-center-v2/screenshots/phase-d");
test("Phase D: actual editor reuse, reference navigation and recoverable file lifecycle", async ({ page, request, browser }) => {
  fs.mkdirSync(evidence, { recursive: true });
  const account = await (await request.post("/api/auth/login", { data: { username: "assets_qa", password: "assets-qa-only-password" } })).json();
  const headers = { Authorization: `Bearer ${account.token}` };
  const markdown = await (await request.post("/api/notes", { headers, data: { notebookId: "assets-qa-notebook", title: "D Markdown insertion", content: "# Existing file\n", contentFormat: "markdown" } })).json();
  const rich = await (await request.post("/api/notes", { headers, data: { notebookId: "assets-qa-notebook", title: "D Rich text insertion", content: JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }), contentFormat: "tiptap-json" } })).json();
  expect(markdown.id).toBeTruthy(); expect(rich.id).toBeTruthy();
  const before = await (await request.get("/api/files?category=image", { headers })).json();
  const image = before.items.find((item: { filename: string }) => item.filename === "项目参考图-2.png");
  await page.addInitScript((tokens) => {
    localStorage.setItem("nowen-token", tokens.token); localStorage.setItem("nowen-refresh-token", tokens.refreshToken);
    localStorage.setItem("i18nextLng", "zh-CN"); localStorage.setItem("nowen-seen-version", tokens.version);
  }, { ...account, version: JSON.parse(fs.readFileSync(path.resolve("../package.json"), "utf8")).version });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  for (const [note, screenshot] of [[markdown, "markdown-library"], [rich, "rich-text-library"]] as const) {
    await page.getByText(note.title, { exact: true }).first().click();
    await page.getByRole("button", { name: "从文件管理插入", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "从文件管理插入" })).toBeVisible();
    await page.screenshot({ path: path.join(evidence, `${screenshot}.png`) });
    await page.getByRole("option").filter({ hasText: image.filename }).click();
    await expect(page.getByRole("dialog", { name: "从文件管理插入" })).toBeHidden();
    await expect.poll(async () => (await (await request.get(`/api/notes/${note.id}`, { headers })).json()).content, { timeout: 20_000 }).toContain(`/api/attachments/${image.id}`);
    await expect.poll(async () => {
      const detail = await (await request.get(`/api/files/${image.id}`, { headers })).json();
      return detail.references.some((entry: { id: string }) => entry.id === note.id);
    }, { timeout: 20_000 }).toBe(true);
    const saved = await (await request.get(`/api/notes/${note.id}`, { headers })).json();
    expect(saved.content).toContain(`/api/attachments/${image.id}`);
    if (note.id === rich.id) {
      await expect.poll(() => page.getByRole("img", { name: image.filename, exact: true }).evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    }
  }
  expect((await (await request.get("/api/files?category=image", { headers })).json()).total).toBe(before.total);
  await page.getByRole("button", { name: "文件管理", exact: true }).click();
  await page.getByRole("button", { name: "图片", exact: true }).first().click();
  await page.getByRole("button", { name: image.filename, exact: true }).click();
  await expect(page.getByText("D Markdown insertion", { exact: true }).last()).toBeVisible();
  await page.screenshot({ path: path.join(evidence, "authorized-references.png") });
  await page.getByText("D Markdown insertion", { exact: true }).last().click();
  await expect(page.getByRole("button", { name: "从文件管理插入", exact: true })).toBeVisible();
  const upload = await request.post("/api/files/upload", { headers, multipart: { file: { name: "D-retained.txt", mimeType: "text/plain", buffer: Buffer.from("D recoverable original bytes") }, folderId: "qa-documents" } });
  expect(upload.status()).toBe(201); const file = await upload.json();
  const deleted = await request.delete(`/api/files/${file.id}`, { headers }); expect(deleted.ok()).toBe(true);
  await page.getByRole("button", { name: "文件管理", exact: true }).click();
  await page.getByRole("button", { name: "文件回收站", exact: true }).click();
  await expect(page.getByText("D-retained.txt", { exact: true })).toBeVisible();
  await expect(page.getByText("图片已插入", { exact: true })).toBeHidden({ timeout: 10_000 });
  await page.screenshot({ path: path.join(evidence, "file-recycle-bin.png") });
  await page.getByRole("checkbox", { name: "D-retained.txt" }).check();
  await page.getByRole("button", { name: "恢复所选文件" }).click();
  await expect(page.getByText("回收站为空", { exact: true })).toBeVisible();
  const restored = await (await request.get(`/api/files/${file.id}`, { headers })).json();
  expect(restored.id).toBe(file.id); expect(restored.folderId).toBe("qa-documents");
  const response = await request.get(restored.accessUrls[file.id]); expect((await response.body()).toString()).toBe("D recoverable original bytes");
  expect((await request.delete(`/api/files/${file.id}`, { headers })).ok()).toBe(true);
  await page.getByRole("button", { name: "返回文件中心" }).click();
  await page.getByRole("button", { name: "文件回收站", exact: true }).click();
  await page.getByRole("checkbox", { name: "D-retained.txt" }).check();
  await page.getByRole("button", { name: "永久删除所选文件" }).click();
  await expect(page.getByText(/永久删除 1 个文件后无法/)).toBeVisible();
  await page.screenshot({ path: path.join(evidence, "permanent-delete-confirmation.png") });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(evidence, "mobile-recycle-bin.png") });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({ path: path.join(evidence, "dark-recycle-bin.png") });
  const englishContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await englishContext.addInitScript((tokens) => {
    localStorage.setItem("nowen-token", tokens.token); localStorage.setItem("nowen-refresh-token", tokens.refreshToken);
    localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", tokens.version);
  }, { ...account, version: JSON.parse(fs.readFileSync(path.resolve("../package.json"), "utf8")).version });
  const english = await englishContext.newPage();
  await english.goto("http://127.0.0.1:4197/");
  await english.getByLabel("Files", { exact: true }).click();
  await english.getByRole("button", { name: "File recycle bin", exact: true }).click();
  await expect(english.getByText("D-retained.txt", { exact: true })).toBeVisible();
  await english.screenshot({ path: path.join(evidence, "english-recycle-bin.png") });
  await englishContext.close();
  expect(errors).toEqual([]);
});
