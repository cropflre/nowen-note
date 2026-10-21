import { test as base, expect, _electron } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";


const root = path.resolve("..");
const electron = createRequire(import.meta.url)("electron") as string;
const test = base.extend<{ product: { server: string; provider: string; directory: string; setOutput: (value: unknown) => void } }>({
  product: async ({ browserName }, provide) => {
    void browserName;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-composer-browser-"));
    let backend: ChildProcess | undefined, logs = "";
    let output: unknown = { tasks: [{ title: "Review report", description: "Check the test results", priority: 3, dueDate: "2026-12-31", dueAt: "2026-12-31T09:00" }, { title: "Record sleep", priority: 2, dueDate: "2026-12-31", repeatRule: "daily", repeatEndCount: 14 }] };
    const provider = http.createServer((request, response) => {
      let raw = "";
      request.on("data", chunk => { raw += chunk; });
      request.on("end", () => {
        const body = JSON.parse(raw);
        const context = body.messages.find((m: any) => m.role === "tool");
        const tool = context
          ? { name: "propose_note_edit", arguments: JSON.stringify({ edits: [{ before: "Agent original sentence", after: "Agent improved sentence" }] }) }
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
      backend = spawn(electron, ["--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href, path.join(root, "backend/tests/task-composer-browser-server.ts")], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TASK_COMPOSER_PROFILE: directory, FRONTEND_DIST: path.join(root, "frontend/dist"), PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
      backend.stdout?.on("data", chunk => { logs += chunk; }); backend.stderr?.on("data", chunk => { logs += chunk; });
      await expect.poll(() => fetch(`${server}/api/health`).then(r => r.ok).catch(() => false), { timeout: 20000, message: "Isolated backend must start" }).toBe(true);
      await provide({ server, provider: providerUrl, directory, setOutput: value => { output = value; } });
    } finally {
      if (backend && backend.exitCode === null) { const exited = new Promise<void>(resolve => backend!.once("exit", () => resolve())); backend.kill(); await exited; }
      await new Promise<void>(resolve => provider.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
      if (backend?.exitCode && backend.exitCode !== 0) console.error(logs.slice(-1000));
    }
  },
});


for (const format of ["markdown", "tiptap-json"] as const) test(`editor Agent ${format}: reject, approve, reload and second browser read`, async ({ page, product, browser }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const registered = await page.request.post(`${product.server}/api/auth/register`, { data: { username: "agent_browser", password: "agent-browser-test-password" } });
  expect(registered.ok()).toBe(true); const account = await registered.json();
  const headers = { Authorization: `Bearer ${account.token}` };
  expect((await page.request.put(`${product.server}/api/ai/settings`, { headers, data: { ai_provider: "openai", ai_api_url: product.provider, ai_api_key: "test-key", ai_model: "tool-test" } })).ok()).toBe(true);
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
  await page.getByRole("button", { name: "Editor Agent", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Editor Agent" });
  await panel.getByLabel("What would you like to change?").fill("Improve the original sentence, keep links and formatting.");
  await panel.getByRole("button", { name: "Generate proposal", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Accept edits" })).toBeVisible();
  await panel.getByRole("button", { name: "Reject", exact: true }).click();
  expect((await (await page.request.get(`${product.server}/api/notes/${note.id}`, { headers })).json()).content).toContain("Agent original sentence");
  await panel.getByRole("button", { name: "Generate again", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Accept edits" })).toBeVisible();
  const editable = page.locator('.cm-content[contenteditable="true"], .ProseMirror[contenteditable="true"]').first();
  await editable.click(); await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.insertText(" Local changes preserved");
  await panel.getByRole("button", { name: "Accept edits" }).click();
  await expect(panel.getByRole("alert")).toContainText("The note changed");
  await panel.getByRole("button", { name: "Reject", exact: true }).click();
  await panel.getByRole("button", { name: "Generate again", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Accept edits" })).toBeVisible();
  await panel.screenshot({ path: test.info().outputPath(`${format}-diff.png`) });
  await panel.getByRole("button", { name: "Accept edits" }).click();
  await expect(panel.getByText("The note save was verified on the server. Check sync receipts for other devices.")).toBeVisible({ timeout: 30000 });
  const saved = await (await page.request.get(`${product.server}/api/notes/${note.id}`, { headers })).json();
  expect(saved.content).toContain("Agent improved sentence"); expect(saved.content).toContain("https://example.com"); expect(saved.content).toContain("Local changes preserved");
  if (format === "tiptap-json") expect(saved.content).toContain('"bold"');
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue("Agent test note");
  const second = await browser.newContext();
  try { const read = await second.request.get(`${product.server}/api/notes/${note.id}`, { headers }); expect((await read.json()).content).toBe(saved.content); } finally { await second.close(); }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Editor Agent", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Collapse" })).toBeVisible();
  expect(await panel.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
});
