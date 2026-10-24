import { createHmac } from "node:crypto";
import { test as base, expect, _electron } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";


const root = fileURLToPath(new URL("../..", import.meta.url));
const providerFile = process.env.NOWEN_AGENT_LIVE_PROVIDER_FILE;
function liveProvider(file: string): { url: string; key: string; model: string } {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof value.url !== "string" || typeof value.key !== "string" || typeof value.model !== "string" || !value.model.trim()) throw new Error();
    const url = new URL(value.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return { url: value.url, key: value.key, model: value.model };
  } catch { throw new Error("Invalid live-provider configuration file"); }
}
const electron = process.env.NOWEN_AGENT_TEST_RUNTIME || createRequire(import.meta.url)("electron") as string;
const test = base.extend<{ product: { server: string; provider: { url: string; key: string; model: string }; directory: string; finishChat: () => void; chatRequests: Array<{ role: string; content: string }[]>; restart: () => Promise<void> } }>({
  page: async ({ page, product }, provide) => {
    if (process.env.NOWEN_AGENT_ELECTRON !== "1") { await provide(page); return; }
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    env.TASK_COMPOSER_ELECTRON_PROFILE = path.join(product.directory, "electron");
    env.TASK_COMPOSER_ELECTRON_URL = product.server;
    const app = await _electron.launch({ executablePath: electron, args: [path.join(root, "frontend/e2e/fixtures/task-composer-electron.cjs")], env });
    try {
      const runtimePath = test.info().outputPath("electron-runtime.json");
      fs.writeFileSync(runtimePath, JSON.stringify(await app.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform, arch: process.arch })), null, 2));
      await test.info().attach("electron-runtime.json", { path: runtimePath, contentType: "application/json" });
      const window = await app.firstWindow();
      await window.waitForLoadState();
      await provide(window);
    } finally {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy()));
      await app.close();
    }
  },
  product: async ({ browserName }, provide) => {
    void browserName;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-composer-browser-"));
    let backend: ChildProcess | undefined, logs = "";
    let finishChat = () => {};
    const chatRequests: Array<{ role: string; content: string }[]> = [];

    const provider = http.createServer((request, response) => {
      let raw = "";
      request.on("data", chunk => { raw += chunk; });
      request.on("end", async () => {
        const body = JSON.parse(raw);
        if (!body.tools && body.messages?.[0]?.content?.includes("You compose task DRAFTS")) {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tasks: [{ title: "Review workflow sources", priority: 3 }, { title: "Publish workflow summary", priority: 2 }] }) } }] }));
          return;
        }
        if (body.tools?.some((tool: { function: { name: string } }) => tool.function.name === "search_notebook")) {
          const context = body.messages.find((message: { role: string }) => message.role === "tool");
          const proposed = context ? { name: "propose_workflow", arguments: JSON.stringify({ summary: "Agent workflow summary based on two sources", sourceNoteIds: JSON.parse(context.content).sources.map((source: { id: string }) => source.id), note: { title: "Agent workflow result", content: "# Agent workflow result\n\nBoth workflowmarker source details are retained." }, taskRequest: "Review workflow sources and publish the summary" }) }
            : { name: "search_notebook", arguments: JSON.stringify({ query: "workflowmarker" }) };
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: context ? "workflow-plan" : "workflow-search", type: "function", function: proposed }] } }] }));
          return;
        }
        if (!body.tools) {
          chatRequests.push(body.messages);
          response.setHeader("Content-Type", "text/event-stream");
          const finished = new Promise<void>(resolve => { finishChat = resolve; });
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Compatibility stream started" } }] })}\n\n`);
          await finished;
          response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: " and completed." } }] })}\n\ndata: [DONE]\n\n`);
          return;
        }
        const context = body.messages.find((m: { role: string }) => m.role === "tool");
        const document = context ? JSON.parse(context.content).untrustedDocument : undefined;
        const empty = document === "" || (typeof document === "string" && document.startsWith("{") && !JSON.parse(document).content?.some((node: { content?: unknown[] }) => node.content?.length));
        const tool = context
          ? { name: "propose_note_edit", arguments: JSON.stringify({ edits: [{ before: empty ? "" : "Agent original sentence", after: empty ? "A new draft for review" : "Agent improved sentence" }] }) }
          : { name: "get_current_note_context", arguments: "{}" };
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: context ? "proposal" : "context", type: "function", function: tool }] } }] }));
      });
    });
    try {
      await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
      const providerUrl = `http://127.0.0.1:${(provider.address() as net.AddressInfo).port}/v1`;
      const port = await new Promise<number>(resolve => { const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => { const port = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(port)); }); });
      const server = `http://127.0.0.1:${port}`;
      const start = async () => {
      backend = spawn(electron, ["--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href, path.join(root, "backend/tests/task-composer-browser-server.ts")], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TASK_COMPOSER_PROFILE: directory, FRONTEND_DIST: path.join(root, "frontend/dist"), PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
      backend.stdout?.on("data", chunk => { logs += chunk; }); backend.stderr?.on("data", chunk => { logs += chunk; });
      await expect.poll(() => fetch(`${server}/api/health`).then(r => r.ok).catch(() => false), { timeout: 20000, message: "Isolated backend must start" }).toBe(true);
      };
      await start();
      await provide({ server, finishChat: () => finishChat(), chatRequests, provider: providerFile ? liveProvider(providerFile) : { url: providerUrl, key: "test-key", model: "tool-test" }, directory, restart: async () => {
        const exited = new Promise<void>(resolve => backend!.once("exit", () => resolve()));
        backend!.kill(); await exited;
        await start();
      } });
    } finally {
      finishChat();
      if (backend && backend.exitCode === null) { const exited = new Promise<void>(resolve => backend!.once("exit", () => resolve())); backend.kill(); await exited; }
      await new Promise<void>(resolve => provider.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
      if (backend?.exitCode && backend.exitCode !== 0) console.error(logs.slice(-1000));
    }
  },
});


for (const format of ["markdown", "tiptap-json"] as const) test(`editor Agent ${format}: reject, approve, reload and second browser read`, async ({ page, product, browser }) => {
  if (providerFile) test.setTimeout(240000);
  let approved: unknown;
  page.on("response", response => { if (response.url().endsWith("/approve") && response.ok()) void response.json().then(value => { approved = value; }); });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const registered = await page.request.post(`${product.server}/api/auth/register`, { data: { username: "agent_browser", password: "agent-browser-test-password" } });
  expect(registered.ok()).toBe(true); const account = await registered.json();
  const headers = { Authorization: `Bearer ${account.token}` };
  expect((await page.request.put(`${product.server}/api/ai/settings`, { headers, data: { ai_provider: "openai", ai_api_url: product.provider.url, ai_api_key: product.provider.key, ai_model: product.provider.model } })).ok()).toBe(true);
  const books = await (await page.request.get(`${product.server}/api/notebooks`, { headers })).json();
  const content = format === "markdown" ? "Agent original sentence\n\n[Keep link](https://example.com)" : JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Agent original sentence", marks: [{ type: "bold" }] }] }, { type: "paragraph", content: [{ type: "text", text: "Keep link", marks: [{ type: "link", attrs: { href: "https://example.com" } }] }] }] });
  const response = await page.request.post(`${product.server}/api/notes`, { headers, data: { title: "Agent test note", notebookId: books[0].id, contentFormat: format, content, contentText: "Agent original sentence Keep link" } });
  expect(response.ok()).toBe(true); const note = await response.json();
  await page.goto(product.server);
  await page.evaluate(() => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", "1.5.3"); });
  await page.reload();
  await page.getByPlaceholder("admin", { exact: true }).fill("agent_browser");
  await page.locator("input[type=password]").fill("agent-browser-test-password");
  await page.locator("button[type=submit]").click();
  await page.getByText("Agent test note", { exact: true }).first().click();
  await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue("Agent test note");
  await page.getByRole("button", { name: "AI Assistant", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "AI Assistant" });
  await panel.getByLabel("What would you like to change?").fill("Replace only the exact text Agent original sentence with Agent improved sentence. Keep every other character, link and formatting unchanged.");
  await panel.getByRole("button", { name: "Generate proposal", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Accept edits" })).toBeVisible({ timeout: providerFile ? 60000 : 5000 });
  await panel.getByRole("button", { name: "Reject", exact: true }).click();
  expect((await (await page.request.get(`${product.server}/api/notes/${note.id}`, { headers })).json()).content).toContain("Agent original sentence");
  await panel.getByRole("button", { name: "Generate again", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Accept edits" })).toBeVisible({ timeout: providerFile ? 60000 : 5000 });
  const editable = page.locator('.cm-content[contenteditable="true"], .ProseMirror[contenteditable="true"]').first();
  await editable.click(); await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.insertText(" Local changes preserved");
  await panel.getByRole("button", { name: "Accept edits" }).click();
  await expect(panel.getByRole("alert")).toContainText("The note changed");
  await panel.getByRole("button", { name: "Reject", exact: true }).click();
  // The pending autosave is itself a version change. Regenerate after that save settles.
  await expect.poll(async () => (await (await page.request.get(`${product.server}/api/notes/${note.id}`, { headers })).json()).content).toContain("Local changes preserved");
  await panel.getByRole("button", { name: "Generate again", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Accept edits" })).toBeVisible({ timeout: providerFile ? 60000 : 5000 });
  await panel.screenshot({ path: test.info().outputPath(`${format}-diff.png`) });
  await panel.getByRole("button", { name: "Accept edits" }).click();
  try { await expect(panel.getByText("The note save was verified. Check sync receipts for other devices.")).toBeVisible({ timeout: 25000 }); }
  catch (error) {
    const persisted = await (await page.request.get(`${product.server}/api/notes/${note.id}`, { headers: { ...headers, Accept: "application/vnd.nowen.internal-note+json" } })).json();
    const latest = await (await page.request.get(`${product.server}/api/agent/runs?noteId=${note.id}`, { headers })).json();
    fs.writeFileSync(test.info().outputPath("synthetic-save-debug.json"), JSON.stringify({ approved, persisted, latest }, null, 2));
    throw error;
  }
  const saved = await (await page.request.get(`${product.server}/api/notes/${note.id}`, { headers })).json();
  expect(saved.content).toContain("Agent improved sentence"); expect(saved.content).toContain("https://example.com"); expect(saved.content).toContain("Local changes preserved");
  if (format === "tiptap-json") expect(saved.content).toContain('"bold"');
  await editable.click(); await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await (await page.request.get(`${product.server}/api/notes/${note.id}`, { headers })).json()).content).toContain("Agent original sentence");
  // Shift produces uppercase Z; lowercase z can match CodeMirror Undo on Linux.
  expect((await (await page.request.get(`${product.server}/api/notes/${note.id}`, { headers })).json()).content).toContain("Local changes preserved");
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect.poll(async () => (await (await page.request.get(`${product.server}/api/notes/${note.id}`, { headers })).json()).content).toContain("Agent improved sentence");
  // Restart the actual backend process with the same isolated on-disk database.
  const pendingNote = await (await page.request.post(`${product.server}/api/notes`, { headers, data: { title: "Interrupted proposal", notebookId: books[0].id, contentFormat: format, content } })).json();
  const pendingRun = await (await page.request.post(`${product.server}/api/agent/runs`, { headers, data: { noteId: pendingNote.id, instruction: "Replace only Agent original sentence with Agent improved sentence; preserve all other content", content: pendingNote.content, format, version: pendingNote.version } })).json();
  let pending: { status: string; proposal: { token: string } } | undefined;
  await expect.poll(async () => { pending = await (await page.request.get(`${product.server}/api/agent/runs/${pendingRun.id}`, { headers })).json(); return pending.status; }, { timeout: providerFile ? 60000 : 5000 }).toBe("waiting_approval");
  await product.restart();
  const resumed = await (await page.request.get(`${product.server}/api/agent/runs/${pendingRun.id}`, { headers })).json();
  expect(resumed.status).toBe("interrupted"); expect(resumed.errorCode).toBe("SERVER_RESTARTED"); expect(resumed.proposal).toBeUndefined();
  expect((await page.request.post(`${product.server}/api/agent/runs/${pendingRun.id}/approve`, { headers, data: { token: pending!.proposal.token, snapshot: pendingNote.content } })).status()).toBe(409);
  expect((await (await page.request.get(`${product.server}/api/notes/${pendingNote.id}`, { headers })).json()).content).toBe(pendingNote.content);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue("Agent test note");
  const second = await browser.newContext();
  try { const read = await second.request.get(`${product.server}/api/notes/${note.id}`, { headers }); expect((await read.json()).content).toBe(saved.content); } finally { await second.close(); }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "AI Assistant", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Collapse" })).toBeVisible();
  expect(await panel.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
});

for (const format of ["markdown", "tiptap-json"] as const) test(`AI assistant entry, guidance and approved empty draft (${format})`, async ({ page, product }) => {
  test.skip(!!providerFile, "Uses the isolated deterministic model fixture");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const account = await (await page.request.post(`${product.server}/api/auth/register`, { data: { username: "assistant_ux", password: "assistant-ux-test-password" } })).json();
  const headers = { Authorization: `Bearer ${account.token}` };
  expect((await page.request.put(`${product.server}/api/ai/settings`, { headers, data: { ai_provider: "openai", ai_api_url: product.provider.url, ai_api_key: product.provider.key, ai_model: product.provider.model } })).ok()).toBe(true);
  const books = await (await page.request.get(`${product.server}/api/notebooks`, { headers })).json();
  const created = await page.request.post(`${product.server}/api/notes`, { headers, data: { title: "Assistant layout review", notebookId: books[0].id, contentFormat: format, content: format === "markdown" ? "" : JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }), contentText: "" } });
  expect(created.ok()).toBe(true); const note = await created.json();
  await page.goto(product.server);
  await page.evaluate(() => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", "1.5.3"); });
  await page.reload();
  await page.getByPlaceholder("admin", { exact: true }).fill("assistant_ux");
  await page.locator("input[type=password]").fill("assistant-ux-test-password");
  await page.locator("button[type=submit]").click();
  await page.getByText("Assistant layout review", { exact: true }).first().click();
  await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue("Assistant layout review");
  const entry = page.locator('[data-editor-ai-entry="desktop"]');
  await expect(entry).toBeVisible();
  // The AI entry belongs to the existing header rather than a separate horizontal strip.
  const header = entry.locator('xpath=ancestor::div[contains(@class, "hidden md:flex")]');
  await expect(header).toHaveCount(1);
  await expect.poll(async () => (await header.boundingBox())?.height ?? Infinity).toBeLessThan(75);
  for (const width of [1024, 900, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => header.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  }
  await page.screenshot({ path: test.info().outputPath(`${format}-entry-light.png`) });
  await entry.click();
  const panel = page.getByRole("complementary", { name: "AI Assistant", exact: true });
  await expect(panel.getByText("Current note", { exact: true })).toBeVisible();
  await expect(panel.getByText("Start with an idea", { exact: true })).toBeVisible();
  await expect(panel.getByLabel("What would you like to change?")).toBeFocused();
  await panel.getByRole("button", { name: "Draft content", exact: true }).click();
  expect((await (await page.request.get(`${product.server}/api/agent/runs?noteId=${note.id}`, { headers })).json())).toBeNull();
  await page.screenshot({ path: test.info().outputPath(`${format}-empty-light.png`) });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.evaluate(() => { document.documentElement.classList.add("dark"); });
  await page.screenshot({ path: test.info().outputPath(`${format}-empty-dark.png`) });
  await panel.getByLabel("What would you like to change?").fill("Draft a short note about this week's progress for my approval.");
  await panel.getByRole("button", { name: "Generate proposal", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Accept edits" })).toBeVisible();
  await expect(panel.getByText("Empty note", { exact: true })).toBeVisible();
  expect((await (await page.request.get(`${product.server}/api/notes/${note.id}`, { headers })).json()).content).not.toContain("A new draft for review");
  await panel.getByRole("button", { name: "Accept edits" }).click();
  await expect(panel.getByText("The note save was verified. Check sync receipts for other devices.", { exact: true })).toBeVisible();
  expect((await (await page.request.get(`${product.server}/api/notes/${note.id}`, { headers })).json()).content).toContain("A new draft for review");
  const editable = page.locator('.cm-content[contenteditable="true"], .ProseMirror[contenteditable="true"]').first();
  await editable.click(); await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await (await page.request.get(`${product.server}/api/notes/${note.id}`, { headers })).json()).content).not.toContain("A new draft for review");
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect.poll(async () => (await (await page.request.get(`${product.server}/api/notes/${note.id}`, { headers })).json()).content).toContain("A new draft for review");
  await panel.getByLabel("What would you like to change?").focus();
  await page.keyboard.press("Escape"); await expect(panel).not.toBeVisible();
  await editable.click(); await page.keyboard.press("ControlOrMeta+a");
  await entry.click();
  await expect(panel.getByText("Selected text", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Polish selection", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath(`${format}-selection-dark.png`) });
  await panel.getByRole("button", { name: "Collapse", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 667 });
  await page.locator('[data-editor-ai-entry="mobile"]').click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Collapse", exact: true })).toBeInViewport();
  await expect(panel.getByLabel("What would you like to change?")).toBeInViewport();
  expect(await panel.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  await panel.getByRole("button", { name: "Collapse", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(panel.locator("summary")).toBeFocused();
  await page.screenshot({ path: test.info().outputPath(`${format}-mobile-dark.png`) });
  await page.evaluate(() => { localStorage.setItem("i18nextLng", "zh-CN"); localStorage.setItem("nowen-note-theme", "dark"); });
  await page.reload();
  await page.locator('[data-editor-ai-entry="mobile"]').click();
  const chinesePanel = page.getByRole("complementary", { name: "AI 助手", exact: true });
  await expect(chinesePanel.getByText("当前笔记", { exact: true })).toBeVisible();
  await expect(chinesePanel.getByRole("button", { name: "润色全文", exact: true })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath(`${format}-mobile-zh-dark.png`) });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: test.info().outputPath(`${format}-desktop-zh-dark.png`) });
});

test("live model optimizes a Chinese note through preview and verified editor saving", async ({ page, product }) => {
  test.skip(!providerFile, "Requires an explicitly supplied live-provider credential file");
  test.setTimeout(180000);
  const registered = await page.request.post(`${product.server}/api/auth/register`, { data: { username: "agent_natural", password: "agent-natural-test-password" } });
  expect(registered.ok()).toBe(true); const account = await registered.json();
  const headers = { Authorization: `Bearer ${account.token}` };
  expect((await page.request.put(`${product.server}/api/ai/settings`, { headers, data: { ai_provider: "openai", ai_api_url: product.provider.url, ai_api_key: product.provider.key, ai_model: product.provider.model } })).ok()).toBe(true);
  const books = await (await page.request.get(`${product.server}/api/notebooks`, { headers })).json();
  const content = "# 保存说明\n\n服务会每隔5分钟去进行一次笔记保存这个操作，这个操作的目的主要是为了把笔记内容保存下来。\n\n网络断开的时候修改会保留在本地的待发送队列里面，等网络恢复之后再把这些修改发送出去。\n\n[技术说明](https://example.com/sync)";
  const created = await page.request.post(`${product.server}/api/notes`, { headers, data: { title: "中文优化验收", notebookId: books[0].id, contentFormat: "markdown", content } });
  expect(created.ok()).toBe(true); const note = await created.json();
  await page.goto(product.server);
  await page.evaluate(() => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", "1.5.3"); });
  await page.reload();
  await page.getByPlaceholder("admin", { exact: true }).fill("agent_natural");
  await page.locator("input[type=password]").fill("agent-natural-test-password");
  await page.locator("button[type=submit]").click();
  await page.getByText("中文优化验收", { exact: true }).first().click();
  await page.getByRole("button", { name: "AI Assistant", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "AI Assistant" });
  await panel.getByLabel("What would you like to change?").fill("帮我优化这篇文档，让表达简洁清晰，保留全部技术细节，包括5分钟、本地队列和恢复网络后发送的行为。不要修改标题或链接。");
  await panel.getByRole("button", { name: "Generate proposal", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Accept edits" })).toBeVisible({ timeout: 60000 });
  const proposed = await (await page.request.get(`${product.server}/api/agent/runs?noteId=${note.id}`, { headers })).json();
  expect(proposed.proposal.result).not.toBe(proposed.proposal.original);
  expect(proposed.proposal.result).toContain("5分钟"); expect(proposed.proposal.result).toContain("https://example.com/sync");
  expect(proposed.steps.some((step: { toolName: string; status: string }) => step.toolName === "get_current_note_context" && step.status === "completed")).toBe(true);
  await panel.screenshot({ path: test.info().outputPath("chinese-live-diff.png") });
  await panel.getByRole("button", { name: "Accept edits" }).click();
  await expect(panel.getByText("The note save was verified. Check sync receipts for other devices.")).toBeVisible({ timeout: 25000 });
  const saved = await (await page.request.get(`${product.server}/api/notes/${note.id}`, { headers: { ...headers, Accept: "application/vnd.nowen.internal-note+json" } })).json();
  await product.restart(); await page.reload();
  await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue("中文优化验收");
  const reopened = await (await page.request.get(`${product.server}/api/notes/${note.id}`, { headers: { ...headers, Accept: "application/vnd.nowen.internal-note+json" } })).json();
  expect(reopened.content).toBe(saved.content);
  for (const blockId of proposed.proposal.original.match(/\^blk_[0-9a-f-]{36}/g) || []) expect(reopened.content).toContain(blockId);
  const completed = await (await page.request.get(`${product.server}/api/agent/runs/${proposed.id}`, { headers })).json();
  expect(completed.status).toBe("completed");
  // Only synthetic content and bounded public metadata enter the evidence file.
  fs.writeFileSync(test.info().outputPath("live-evidence.json"), JSON.stringify({ provider: product.provider.url, model: product.provider.model, status: completed.status, usage: completed.usage, original: proposed.proposal.original, result: reopened.content, tools: completed.steps.map((step: { toolName: string; status: string }) => ({ tool: step.toolName, status: step.status })), persistedAfterProcessRestart: true }, null, 2));
});


test("existing Q&A history and streaming survive Agent tab switches and process restart", async ({ page, product }) => {
  test.skip(!!providerFile, "Uses a controlled stream to switch tabs before completion");
  const registered = await page.request.post(`${product.server}/api/auth/register`, { data: { username: "agent_chat", password: "agent-chat-test-password" } });
  expect(registered.ok()).toBe(true);
  const account = await registered.json();
  const headers = { Authorization: `Bearer ${account.token}` };
  expect((await page.request.put(`${product.server}/api/ai/settings`, { headers, data: { ai_provider: "openai", ai_api_url: product.provider.url, ai_api_key: product.provider.key, ai_model: product.provider.model } })).ok()).toBe(true);
  const created = await page.request.post(`${product.server}/api/ai/conversations`, { headers, data: { title: "Existing conversation" } });
  expect(created.ok()).toBe(true);
  const { conversation } = await created.json();
  for (const message of [{ role: "user", content: "Historical question" }, { role: "assistant", content: "Historical answer" }]) {
    expect((await page.request.post(`${product.server}/api/ai/chat-history`, { headers, data: { ...message, conversationId: conversation.id } })).ok()).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(product.server);
  await page.evaluate(() => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", "1.5.3"); });
  await page.reload();
  await page.getByPlaceholder("admin", { exact: true }).fill("agent_chat");
  await page.locator("input[type=password]").fill("agent-chat-test-password");
  await page.locator("button[type=submit]").click();
  // First-login onboarding must finish before this scenario navigates to chat.
  await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue("欢迎使用 Nowen Note");
  await page.getByRole("button", { name: "AI Chat", exact: true }).click();
  await expect(page.locator("p").filter({ hasText: /^Historical answer$/ })).toBeVisible();
  const input = page.getByPlaceholder("Ask a question, AI will answer based on your knowledge base...");
  await input.fill("Continue the previous conversation");
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(input).toBeHidden();
  await page.getByRole("button", { name: "Q&A", exact: true }).click();
  await expect(input).toHaveValue("Continue the previous conversation");
  await expect(page.getByText("Historical question", { exact: true })).toBeVisible();
  await input.press("Enter");
  await expect(page.locator("p").filter({ hasText: /^Compatibility stream started$/ })).toBeVisible();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  product.finishChat();
  const history = async () => (await (await page.request.get(`${product.server}/api/ai/chat-history?conversationId=${conversation.id}`, { headers })).json()).messages;
  await expect.poll(async () => (await history()).map((message: { content: string }) => message.content)).toEqual(["Historical question", "Historical answer", "Continue the previous conversation", "Compatibility stream started and completed."]);
  expect(product.chatRequests).toHaveLength(1);
  expect(product.chatRequests[0]).toEqual(expect.arrayContaining([{ role: "user", content: "Historical question" }, { role: "assistant", content: "Historical answer" }]));
  await page.getByRole("button", { name: "Q&A", exact: true }).click();
  await expect(page.locator("p").filter({ hasText: /^Compatibility stream started and completed\.$/ })).toBeVisible();
  await product.restart();
  await page.reload();
  // First-login onboarding must finish before this scenario navigates to chat.
  await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue("欢迎使用 Nowen Note");
  await page.getByRole("button", { name: "AI Chat", exact: true }).click();
  await expect(page.locator("p").filter({ hasText: /^Historical answer$/ })).toBeVisible();
  await expect(page.locator("p").filter({ hasText: /^Compatibility stream started and completed\.$/ })).toBeVisible();
  expect(await history()).toHaveLength(4);
});


test("notebook Agent previews scoped sources, approves linked notes and tasks, and restores result links", async ({ page, product }) => {
  test.skip(!!providerFile, "Uses the deterministic workflow provider");
  const registered = await page.request.post(`${product.server}/api/auth/register`, { data: { username: "workflow_browser", password: "workflow-browser-test-password" } });
  expect(registered.ok()).toBe(true); const account = await registered.json();
  const headers = { Authorization: `Bearer ${account.token}` };
  expect((await page.request.put(`${product.server}/api/ai/settings`, { headers, data: { ai_provider: "openai", ai_api_url: product.provider.url, ai_api_key: product.provider.key, ai_model: product.provider.model } })).ok()).toBe(true);
  const books = await (await page.request.get(`${product.server}/api/notebooks`, { headers })).json();
  const sources = [];
  for (let i = 1; i <= 2; i++) {
    const response = await page.request.post(`${product.server}/api/notes`, { headers, data: { title: `Workflow source ${i}`, notebookId: books[0].id, contentFormat: "markdown", content: `workflowmarker source ${i}: keep all technical details.` } });
    expect(response.ok()).toBe(true); sources.push(await response.json());
  }
  const noteList = async () => (await (await page.request.get(`${product.server}/api/notes`, { headers })).json());
  const originalCount = (await noteList()).length;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(product.server);
  await page.evaluate(() => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", "1.5.3"); });
  await page.reload();
  await page.getByPlaceholder("admin", { exact: true }).fill("workflow_browser");
  await page.locator("input[type=password]").fill("workflow-browser-test-password");
  await page.locator("button[type=submit]").click();
  await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue("欢迎使用 Nowen Note");
  await page.getByRole("button", { name: "AI Chat", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  const panel = page.getByRole("region", { name: "Notebook Agent", exact: true });
  await panel.getByLabel("Notebook scope", { exact: true }).selectOption(books[0].id);
  await panel.getByLabel("What would you like to change?").fill("Summarize workflowmarker sources, create a new note and extract two tasks.");
  await panel.getByRole("button", { name: "Generate proposal", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Approve and create the displayed drafts", exact: true })).toBeVisible({ timeout: 15000 });
  for (const source of sources) await expect(panel.getByRole("button", { name: source.title, exact: true })).toBeVisible();
  expect((await noteList()).length).toBe(originalCount);
  expect(await (await page.request.get(`${product.server}/api/tasks`, { headers })).json()).toHaveLength(0);
  await panel.getByRole("button", { name: "Reject", exact: true }).click();
  expect((await noteList()).length).toBe(originalCount);
  await panel.getByRole("button", { name: "Generate proposal", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Approve and create the displayed drafts", exact: true })).toBeVisible({ timeout: 15000 });
  await panel.screenshot({ path: test.info().outputPath("notebook-workflow-preview.png") });
  // The server commits, but the approval response is lost. The UI must reconcile by GET.
  await page.route(/\/api\/agent\/workflows\/[^/?]+\/approve(?:\?.*)?$/, async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
  await panel.getByRole("button", { name: "Approve and create the displayed drafts", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Open created note", exact: true })).toBeVisible({ timeout: 15000 });
  const createdNote = (await noteList()).find((note: { title: string }) => note.title === "Agent workflow result");
  expect(createdNote).toBeTruthy(); expect((await noteList()).length).toBe(originalCount + 1);
  const tasks = await (await page.request.get(`${product.server}/api/tasks`, { headers })).json();
  expect(tasks).toHaveLength(2); expect(tasks.every((task: { noteId: string }) => task.noteId === createdNote.id)).toBe(true);
  await panel.getByRole("button", { name: "Open task 1", exact: true }).click();
  await expect(page.getByText("Review workflow sources", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "AI Chat", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await panel.getByRole("button", { name: "Open created note", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue("Agent workflow result");
  await product.restart(); await page.reload();
  await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue("Agent workflow result");
  await page.getByRole("button", { name: "AI Chat", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Open created note", exact: true })).toBeVisible();
  await expect(panel.getByText("Draft details have expired or were interrupted. Created result links remain available; generate a new request to continue.", { exact: true })).toBeVisible();
  expect(await (await page.request.get(`${product.server}/api/tasks`, { headers })).json()).toHaveLength(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});


test("P2 template UI and signed webhook generate an approval-bound workflow", async ({ page, product }) => {
  test.skip(!!providerFile, "Uses the deterministic workflow provider");
  const registered = await page.request.post(`${product.server}/api/auth/register`, { data: { username: "p2_browser", password: "p2-browser-test-password" } });
  expect(registered.ok()).toBe(true); const account = await registered.json();
  const headers = { Authorization: `Bearer ${account.token}` };
  expect((await page.request.put(`${product.server}/api/ai/settings`, { headers, data: { ai_provider: "openai", ai_api_url: product.provider.url, ai_api_key: product.provider.key, ai_model: product.provider.model } })).ok()).toBe(true);
  const books = await (await page.request.get(`${product.server}/api/notebooks`, { headers })).json();
  const seeded = await page.request.post(`${product.server}/api/notes`, { headers, data: { title: "P2 source", notebookId: books[0].id, contentFormat: "markdown", content: "workflowmarker: summarize the approved evidence." } });
  expect(seeded.ok()).toBe(true);
  const noteList = async () => { const value = await (await page.request.get(`${product.server}/api/notes`, { headers })).json(); return Array.isArray(value) ? value : value.notes; };
  const original = (await noteList()).length;
  await page.goto(product.server);
  await page.evaluate(() => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", "1.5.3"); });
  await page.reload(); await page.getByPlaceholder("admin", { exact: true }).fill("p2_browser");
  await page.locator("input[type=password]").fill("p2-browser-test-password"); await page.locator("button[type=submit]").click();
  await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue(/欢迎|Welcome/);
  await page.getByRole("button", { name: "AI Chat", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  const panel = page.getByRole("region", { name: "Notebook Agent", exact: true });
  await panel.getByRole("button", { name: "Templates and recurring organization", exact: true }).click();
  const library = page.getByRole("region", { name: "Templates and recurring organization", exact: true });
  await library.getByLabel("Template name", { exact: true }).fill("Weekly review");
  await library.getByLabel("Template notebook scope", { exact: true }).selectOption(books[0].id);
  await library.getByLabel("Template instruction", { exact: true }).fill("Summarize workflowmarker and create a note and two task drafts.");
  await library.getByLabel("Allow proposing new notes", { exact: true }).check();
  await library.getByLabel("Allow proposing task batches", { exact: true }).check();
  await library.getByRole("button", { name: "Save template", exact: true }).click();
  await expect(library.getByRole("button", { name: "Use template", exact: true })).toBeVisible();
  const templates = await (await page.request.get(`${product.server}/api/agent/library/templates?workspaceId=personal`, { headers })).json();
  await library.getByRole("button", { name: "Use template", exact: true }).click();
  await expect(panel.getByLabel("What would you like to change?")).toBeDisabled();
  await panel.getByRole("button", { name: "Generate proposal", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Approve and create the displayed drafts", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Reject", exact: true }).click();
  expect((await noteList()).length).toBe(original);
  await panel.getByRole("button", { name: "Templates and recurring organization", exact: true }).click();
  await library.getByLabel("Select Agent template", { exact: true }).selectOption(templates[0].id);
  await library.getByLabel("Trigger", { exact: true }).selectOption("webhook");
  const createdResponse = page.waitForResponse(r => r.url().includes("/automations?workspaceId=") && r.request().method() === "POST");
  await library.getByRole("button", { name: "Create a disabled organization plan", exact: true }).click();
  const created = await (await createdResponse).json();
  expect(created.enabled).toBe(false); expect(created.webhookCredentials.secret).toBeTruthy();
  await library.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(library.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  const raw = JSON.stringify({ instruction: "FORGED_WEBHOOK_INSTRUCTION" });
  const timestamp = String(Math.floor(Date.now()/1000));
  const signature = createHmac("sha256", created.webhookCredentials.secret).update(`${timestamp}.`).update(raw).digest("hex");
  const hookUrl = `${product.server}/api/automation/webhooks/${created.webhookCredentials.token}`;
  const trigger = () => page.request.post(hookUrl, { headers: { "Content-Type": "application/json", "X-Nowen-Timestamp": timestamp, "X-Nowen-Signature": `sha256=${signature}` }, data: raw });
  expect((await trigger()).status()).toBe(202); expect((await trigger()).status()).toBe(409);
  const history = async () => (await page.request.get(`${product.server}/api/agent/workflows?workspaceId=personal`, { headers })).json();
  await expect.poll(async () => (await history())[0]?.status).toBe("waiting_approval");
  expect((await noteList()).length).toBe(original);
  expect(await (await page.request.get(`${product.server}/api/tasks`, { headers })).json()).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue(/欢迎|Welcome/);
  await page.getByRole("button", { name: "AI Chat", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Approve and create the displayed drafts", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Approve and create the displayed drafts", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Open created note", exact: true })).toBeVisible();
  expect((await noteList()).length).toBe(original+1);
  expect(await (await page.request.get(`${product.server}/api/tasks`, { headers })).json()).toHaveLength(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole("button", { name: "Templates and recurring organization", exact: true }).click();
  await expect(library.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  expect(await library.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await library.screenshot({ path: test.info().outputPath("p2-template-library.png") });
  await library.getByRole("button", { name: "Pause", exact: true }).click();
});

test("live P2 template retrieves two notes and persists an approved summary", async ({ page, product }) => {
  test.skip(!providerFile, "Requires an explicitly supplied live-provider credential file");
  test.setTimeout(180000);
  const registered = await page.request.post(`${product.server}/api/auth/register`, { data: { username: "p2_live", password: "p2-live-test-password" } });
  expect(registered.ok()).toBe(true); const account = await registered.json();
  const headers = { Authorization: `Bearer ${account.token}` };
  expect((await page.request.put(`${product.server}/api/ai/settings`, { headers, data: { ai_provider: "openai", ai_api_url: product.provider.url, ai_api_key: product.provider.key, ai_model: product.provider.model } })).ok()).toBe(true);
  const books = await (await page.request.get(`${product.server}/api/notebooks`, { headers })).json();
  const sources = [];
  for (const [index, content] of ["p2livemarker：服务每隔5分钟保存笔记。离线修改保留在本地待发送队列。", "p2livemarker：恢复网络后发送待发送队列，失败最多重试3次。"].entries()) {
    const created = await page.request.post(`${product.server}/api/notes`, { headers, data: { title: `P2 live source ${index + 1}`, notebookId: books[0].id, contentFormat: "markdown", content } });
    expect(created.ok()).toBe(true); sources.push(await created.json());
  }
  const noteList = async () => (await page.request.get(`${product.server}/api/notes`, { headers })).json();
  const before = (await noteList()).length;
  const input = { notebookId: books[0].id, includeChildren: false, timezone: "Asia/Shanghai", lang: "zh-CN", instruction: "Search for p2livemarker and summarize both source notes in Chinese. Propose exactly one new Markdown note titled P2 真实模型验收总结. Preserve every technical fact: 5分钟保存、离线时本地待发送队列、恢复网络后发送、失败最多重试3次. Do not create tasks or call extensions. Do not change source notes." };
  const templateResponse = await page.request.post(`${product.server}/api/agent/library/templates?workspaceId=personal`, { headers, data: { name: "Live P2 summary", input, allowNote: true, allowTasks: false, toolIds: [] } });
  expect(templateResponse.ok()).toBe(true); const template = await templateResponse.json();
  const start = await page.request.post(`${product.server}/api/agent/workflows?workspaceId=personal`, { headers, data: { ...input, templateId: template.id, templateRevision: template.revision } });
  expect(start.status()).toBe(202); const { id } = await start.json();
  const workflow = async () => (await page.request.get(`${product.server}/api/agent/workflows/${id}?workspaceId=personal`, { headers })).json();
  await expect.poll(async () => (await workflow()).status, { timeout: 120000 }).toBe("waiting_approval");
  const proposed = await workflow();
  for (const source of sources) expect(proposed.preview.sources.map((item: { id: string }) => item.id)).toContain(source.id);
  expect(proposed.preview.tasks).toBeUndefined(); expect(proposed.preview.extensionCalls || []).toHaveLength(0);
  expect((await noteList()).length).toBe(before);
  await page.goto(product.server);
  await page.evaluate(() => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", "1.5.3"); });
  await page.reload(); await page.getByPlaceholder("admin", { exact: true }).fill("p2_live");
  await page.locator("input[type=password]").fill("p2-live-test-password"); await page.locator("button[type=submit]").click();
  await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue(/欢迎|Welcome/);
  await page.getByRole("button", { name: "AI Chat", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  const panel = page.getByRole("region", { name: "Notebook Agent", exact: true });
  await panel.getByRole("button", { name: "Approve and create the displayed drafts", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Open created note", exact: true })).toBeVisible();
  const completed = await workflow(); expect(completed.status).toBe("completed");
  const noteId = completed.actions.find((action: { kind: string }) => action.kind === "note").resourceIds[0];
  const readNote = async () => (await page.request.get(`${product.server}/api/notes/${noteId}`, { headers: { ...headers, Accept: "application/vnd.nowen.internal-note+json" } })).json();
  const saved = await readNote();
  expect(saved.content).toBeTruthy(); expect((await noteList()).length).toBe(before + 1);
  for (const fact of [/[5五]\s*分钟/, /[3三]\s*次/, /队列/, /网络/]) expect(saved.content).toMatch(fact);
  await product.restart();
  expect((await readNote()).content).toBe(saved.content);
  expect((await workflow()).status).toBe("completed");
  fs.writeFileSync(test.info().outputPath("p2-live-evidence.json"), JSON.stringify({ model: product.provider.model, status: completed.status, sourceCount: proposed.preview.sources.length, createdNotes: 1, persistedAfterRestart: true }, null, 2));
});
