#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "../frontend/node_modules/playwright-core/index.mjs";
import { createServer } from "../frontend/node_modules/vite/dist/node/index.js";
import { acceptAIMemoryClipper } from "./accept-ai-memory-clipper.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "nowen-ai-memory-acceptance-"));
const output = path.resolve(process.env.NOWEN_AI_MEMORY_REPORT_DIR || path.join(root, "docs/qa/ai-memory-hub-2026-11-05"));
await fs.mkdir(output, { recursive: true });
const checks = [];
let backend, frontend, browser;
let backendOutput = "";
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
async function until(check, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
}
function record(name) { checks.push({ name, status: "passed" }); console.log(`PASS ${name}`); }

try {
  const port = await freePort();
  const backendBase = `http://127.0.0.1:${port}`;
  const environment = { ...process.env, NODE_ENV: "test", DB_PATH: path.join(temporary, "fixture.db"),
    ELECTRON_USER_DATA: temporary, JWT_SECRET: crypto.randomBytes(32).toString("hex"),
    PORT: String(port), DISABLE_MDNS: "1", CALENDAR_EXPORT_TIMER_DISABLED: "1" };
  delete environment.NODE_TEST_CONTEXT;
  backend = spawn(process.execPath, ["--import", "tsx", "src/index.hardened.ts"], {
    cwd: path.join(root, "backend"), env: environment, stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [backend.stdout, backend.stderr]) stream.on("data", chunk => {
    backendOutput = (backendOutput + chunk).slice(-20_000);
  });
  await until(async () => {
    if (backend.exitCode !== null) throw new Error(`Disposable backend exited: ${backendOutput.slice(-3000)}`);
    try { return (await fetch(`${backendBase}/api/health`)).ok; } catch { return false; }
  }, "disposable backend");
  let token;
  async function request(endpoint, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`${backendBase}/api${endpoint}`, { method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.ok(response.ok, `${method} ${endpoint}: ${JSON.stringify(result)}`);
    return result;
  }
  const login = await request("/auth/register", { username: "memory-browser-fixture", password: crypto.randomUUID() });
  token = login.token;
  const notebook = await request("/notebooks", { name: "AI Browser Fixture" });
  const source = await request("/ai-memory/sources", { provider: "chatgpt", accountScope: "browser-fixture",
    displayName: "ChatGPT 本地验收", notebookId: notebook.id, permissionState: "granted", captureEnabled: false });
  const message = { externalMessageId: "fixture-user", localSequence: 0, role: "user", blocks: [{ type: "markdown", text: "只使用本地合成资料" }],
    text: "只使用本地合成资料", captureState: "stable" };
  const payload = { sourceId: source.id, operationId: crypto.randomUUID(), expectedRevision: 0, mode: "manual",
    snapshot: { provider: "chatgpt", accountScope: source.accountScope, externalConversationId: "browser-fixture",
      title: "浏览器验收：原始对话", sourceUrl: "https://chatgpt.com/c/browser-fixture", messages: [message],
      completeness: "partial", capturedAt: new Date().toISOString() } };
  const saved = await request("/ai-memory/conversations/ingest", payload);
  assert.equal(saved.persisted, true);
  assert.equal((await request("/ai-memory/conversations/ingest", payload)).status, "duplicate");
  const messages = await request(`/ai-memory/conversations/${saved.conversationId}/messages`);
  assert.equal(messages.items.length, 1);
  record("production HTTP ingestion, exact replay and persisted message reread");

  process.chdir(path.join(root, "frontend"));
  frontend = await createServer({ root: path.join(root, "frontend"), configFile: path.join(root, "frontend/vite.config.ts"),
    server: { host: "127.0.0.1", port: await freePort(), strictPort: true,
      proxy: { "/api": { target: backendBase, changeOrigin: true } } },
  });
  await frontend.listen();
  const uiBase = frontend.resolvedUrls.local[0].replace(/\/$/, "");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", error => console.error(`Fixture page: ${error.message}`));
  page.on("response", response => { if (response.status() >= 400) console.error(`Fixture HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
  await page.addInitScript(({ access, refresh }) => {
    localStorage.setItem("nowen-token", access);
    localStorage.setItem("nowen-refresh-token", refresh);
  }, { access: token, refresh: login.refreshToken });
  for (const theme of ["light", "dark"]) for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme });
    await page.goto(`${uiBase}/benchmarks/ai-memory-hub.html`);
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.getByText("浏览器验收：原始对话", { exact: true }).waitFor().catch(async error => {
      console.error((await page.locator("body").innerText()).slice(0, 3000));
      throw error;
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${theme}/${width} horizontal overflow`);
    await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), fullPage: true });
    record(`${theme} ${width}px real archive component, reduced motion and no horizontal overflow`);
  }
  const downloadPending = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出原始会话 JSON", exact: true }).click();
  const download = await downloadPending;
  const exportedFile = path.join(temporary, "raw-conversation.json");
  await download.saveAs(exportedFile);
  const exported = JSON.parse(await fs.readFile(exportedFile, "utf8"));
  assert.equal(exported.externalConversationId, "browser-fixture");
  assert.deepEqual(exported.messages[0].blocks, message.blocks);
  assert.equal(exported.messages[0].text, message.text);
  record("user export retains raw message text and content blocks");
  await page.getByRole("button", { name: "长期记忆", exact: true }).click();
  await page.getByText(/长期记忆尚未开放/).waitFor();
  record("long-term memories are explicitly marked unavailable");
  await page.getByRole("button", { name: "连接与同步", exact: true }).click();
  await page.getByLabel("选择已授权的来源").selectOption(source.id);
  await page.locator('input[type="file"]').setInputFiles({ name: "browser-history.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify([
    { externalConversationId: "history-browser-fixture", title: "历史导入浏览器验收", messages: [
      { externalMessageId: "history-message", role: "user", text: "<script>window.fixtureExecuted=true</script> 合成历史记录" },
    ] },
  ])) });
  const startButton = page.getByRole("button", { name: "确认导入", exact: true });
  await startButton.waitFor();
  assert.equal(await startButton.isEnabled(), false);
  await page.getByText(/历史导入浏览器验收 · 1 条消息/).click();
  await page.getByLabel("内容预览").filter({ hasText: "合成历史记录" }).waitFor();
  assert.equal(await page.evaluate(() => window.fixtureExecuted), undefined);
  await page.screenshot({ path: path.join(output, "import-preview-dark-360.png"), fullPage: true });
  await page.getByRole("checkbox", { name: "我已检查会话预览、完整性提示和目标来源", exact: true }).check();
  await startButton.click();
  await page.getByRole("heading", { name: "browser-history.json · 导入完成", exact: true }).waitFor();
  const imported = await request(`/ai-memory/conversations?sourceId=${source.id}&externalConversationId=history-browser-fixture`);
  assert.equal(imported.items.length, 1);
  record("real file preview, inert script text, explicit review, background import and persisted reread");
  await acceptAIMemoryClipper({ chromium, root, temporary, backendBase, login, notebook, request, record });
  await fs.writeFile(path.join(output, "browser.json"), JSON.stringify({
    date: "2026-11-05", runtime: process.version, checks,
    boundaries: ["Disposable SQLite and synthetic account only", "Local UI harness mounts the production component",
      "Real ChatGPT/Doubao accounts, physical devices and store installation are not accepted by this runner"],
  }, null, 2) + "\n");
} catch (error) {
  console.error(error);
  if (backendOutput) console.error(backendOutput.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await frontend?.close();
  if (backend && backend.exitCode === null) {
    backend.kill("SIGTERM");
    await Promise.race([new Promise(resolve => backend.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (backend.exitCode === null) { backend.kill("SIGKILL"); await new Promise(resolve => backend.once("exit", resolve)); }
  }
  await fs.rm(temporary, { recursive: true, force: true });
}
