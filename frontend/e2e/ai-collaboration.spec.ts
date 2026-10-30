import { test, expect, type Page } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
let provider: http.Server;
let token: { token: string; refreshToken: string };
let received: Array<{ messages: Array<{ content: string }> }> = [];
let providerFails = false;
test.beforeAll(async ({ request }) => {
  provider = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); received.push(body);
    res.writeHead(providerFails ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(providerFails ? { error: "fixture unavailable" } : { choices: [{ message: { content: "# 周报功能灵感\n\n增加每周自动整理笔记的入口。\n\n## 下一步\n\n先验证需求与数据来源。" } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const login = await request.post("/api/auth/login", { data: { username: "assets_qa", password: "assets-qa-only-password" } });
  expect(login.ok()).toBe(true); token = await login.json();
  const settings = await request.put("/api/ai/settings", { headers: { Authorization: `Bearer ${token.token}` }, data: {
    ai_provider: "openai", ai_api_url: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, ai_api_key: "fixture-only-key", ai_model: "collaboration-fixture",
  } });
  expect(settings.ok()).toBe(true);
});
test.afterAll(async () => { await new Promise<void>(resolve => provider.close(() => resolve())); });
test.beforeEach(() => { providerFails = false; received = []; });
async function open(page: Page) {
  const version = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  await page.addInitScript(({ token, version }) => {
    localStorage.setItem("nowen-token", token.token); localStorage.setItem("nowen-refresh-token", token.refreshToken);
    localStorage.setItem("i18nextLng", "zh-CN"); localStorage.setItem("nowen-seen-version", version);
  }, { token, version });
  await page.goto("/"); await expect(page.getByRole("button", { name: "插入加密内容", exact: true })).toBeVisible();
  if (page.viewportSize()!.width < 768) await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: "AI 快记", exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: "AI 快记", exact: true })).toBeVisible();
}
for (const width of [320, 390, 1280]) {
  test(`one idea → organize → save with no configuration at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 844 }); await open(page);
    const dialog = page.getByRole("dialog", { name: "AI 快记", exact: true });
    await expect(dialog.getByRole("combobox")).toHaveCount(0);
    await dialog.getByRole("textbox", { name: "想法或工作需求" }).fill(`周报灵感 ${width}：每周整理一下笔记`);
    await page.screenshot({ path: `node_modules/.cache/mobile-layout-results/ai-capture-simple-${width}.png` });
    await dialog.getByRole("button", { name: "帮我整理", exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "草稿预览（可编辑 Markdown）" })).toHaveValue(/周报功能灵感/);
    await expect(dialog.getByRole("combobox")).toHaveCount(0);
    expect(received.length).toBeGreaterThan(0);
    const savedResponse = page.waitForResponse(response => response.url().endsWith("/api/notes") && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "保存笔记", exact: true }).click();
    const saved = await (await savedResponse).json(); expect(saved.id).toBeTruthy();
    const note = await (await request.get(`/api/notes/${saved.id}`, { headers: { Authorization: `Bearer ${token.token}` } })).json();
    expect(note.content).toContain(`周报灵感 ${width}`); expect(note.content).toContain("周报功能灵感");
    await expect(dialog.getByRole("button", { name: "打开笔记", exact: true })).toBeVisible();
    await page.screenshot({ path: `node_modules/.cache/mobile-layout-results/ai-capture-saved-${width}.png` });
    await dialog.getByRole("button", { name: "打开笔记", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/notes/${saved.id}$`));
    await expect(page.getByRole("button", { name: "插入加密内容", exact: true })).toBeVisible();
  });
}
test("configured folder Skills match automatically and use only the chosen project", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const headers = { Authorization: `Bearer ${token.token}` };
  const folder = await (await request.post("/api/notebooks", { headers, data: { name: "834 写作模板" } })).json();
  const skill = await (await request.post("/api/notes", { headers, data: { notebookId: folder.id, title: "项目策划书", contentFormat: "markdown", content: "UNIQUE USER SKILL: include confirmed state, proposal and open questions." } })).json();
  await request.post("/api/notes", { headers, data: { notebookId: "assets-qa-notebook", title: "项目已确认现状", contentFormat: "markdown", content: "VERIFIED SOURCE: the first milestone is complete." } });
  await open(page); const dialog = page.getByRole("dialog", { name: "AI 快记", exact: true });
  await dialog.getByText("补充资料或调整整理方式", { exact: true }).click();
  await dialog.getByLabel("项目资料文件夹", { exact: true }).selectOption("assets-qa-notebook");
  await dialog.getByText("管理写作模板", { exact: true }).click();
  await dialog.getByLabel("Skill 库文件夹", { exact: true }).selectOption(folder.id);
  await expect(dialog.locator(`option[value="note:${skill.id}"]`)).toBeAttached();
  await dialog.getByText("补充资料或调整整理方式", { exact: true }).click();
  await dialog.getByRole("textbox", { name: "想法或工作需求" }).fill("请根据项目现状写一份项目策划书");
  await dialog.getByRole("button", { name: "帮我整理", exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "草稿预览（可编辑 Markdown）" })).toBeVisible();
  const messages = JSON.stringify(received.at(-1)?.messages);
  expect(messages).toContain("UNIQUE USER SKILL"); expect(messages).toContain("VERIFIED SOURCE");
});
test("a failed AI call retains the idea and permits direct save", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 480 }); await open(page); providerFails = true;
  const dialog = page.getByRole("dialog", { name: "AI 快记", exact: true });
  await dialog.getByRole("textbox", { name: "想法或工作需求" }).fill("这条想法不能丢");
  await dialog.getByRole("button", { name: "帮我整理", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "想法或工作需求" })).toHaveValue("这条想法不能丢");
  const direct = dialog.getByRole("button", { name: "直接记下", exact: true });
  await expect(direct).toBeEnabled(); const box = await direct.boundingBox(); expect(box!.y + box!.height).toBeLessThanOrEqual(480);
  await direct.click(); await expect(dialog.getByRole("button", { name: "打开笔记", exact: true })).toBeVisible();
});
