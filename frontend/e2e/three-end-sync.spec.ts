/**
 * 进程级三端同步：真实后端进程 + 真实 Chrome（两个独立浏览器上下文 = Web 端 / PC 端）。
 *
 * 与进程内用例的区别：这里走完整的 Vite 构建产物、真实登录、真实 CodeMirror 键入、
 * 真实 y-codemirror → /ws → 对端编辑器，不注入任何同步状态。
 */
import { test as base, expect, type Page, type BrowserContext, type Locator } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createServer, type ViteDevServer } from "vite";

const root = path.resolve("..");
const runtime = process.env.NOWEN_SYNC_TEST_RUNTIME === "node"
  ? process.execPath
  : createRequire(import.meta.url)("electron") as string;
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const test = base.extend<{ server: string }>({
  server: async ({ browserName }, provide) => {
    void browserName;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-composer-browser-"));
    let backend: ChildProcess | undefined;
    let devServer: ViteDevServer | undefined;
    let logs = "";
    try {
      // 用 Vite dev server 跑当前源码，避免 frontend/dist 里的旧版本构建掩盖本次改动。
      const port = await new Promise<number>(resolve => {
        const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => {
          const port = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(port));
        });
      });
      const server = `http://127.0.0.1:${port}`;
      backend = spawn(runtime, ["--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href, path.join(root, "backend/tests/task-composer-browser-server.ts")], {
        cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TASK_COMPOSER_PROFILE: directory, FRONTEND_DIST: path.join(root, "frontend/dist"), PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      backend.stdout?.on("data", chunk => { logs += chunk; });
      backend.stderr?.on("data", chunk => { logs += chunk; });
      await expect.poll(() => fetch(`${server}/api/health`).then(r => r.ok).catch(() => false), { timeout: 30000 }).toBe(true);
      devServer = await createServer({
        configFile: path.join(root, "frontend/vite.config.ts"),
        server: { host: "127.0.0.1", port: 0, proxy: {
          "/api": { target: server, changeOrigin: true },
          "/ws": { target: server.replace("http:", "ws:"), ws: true },
        } },
      });
      await devServer.listen();
      await provide(devServer.resolvedUrls!.local[0].replace(/\/$/, ""));
    } finally {
      await devServer?.close();
      if (backend && backend.exitCode === null) {
        const exited = new Promise<void>(resolve => backend!.once("exit", () => resolve())); backend.kill(); await exited;
      }
      fs.rmSync(directory, { recursive: true, force: true });
      if (backend?.exitCode && backend.exitCode !== 0) console.error(logs.slice(-2000));
    }
  },
});

const USERNAME = "three_end_user";
const PASSWORD = "three-end-sync-password";

/** 启动独立 Android 端进程（Electron 内置 Node，真实 native SQLite + MobileSyncEngine）。 */
function startAndroid(server: string, token: string) {
  const child = spawn(runtime, [
    "--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href,
    path.join(root, "backend/tests/three-end-android-client.ts"), server, token,
  ], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  type SyncEvent = { event: string; [key: string]: unknown };
  const events: SyncEvent[] = [];
  const waiters: Array<{ predicate: (e: SyncEvent) => boolean; resolve: (e: SyncEvent) => void }> = [];
  let buffer = "";
  let stderr = "";
  child.stdout!.on("data", chunk => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (line.trim()) {
        const event = JSON.parse(line) as SyncEvent;
        events.push(event);
        for (const waiter of [...waiters]) {
          if (waiter.predicate(event)) { waiter.resolve(event); waiters.splice(waiters.indexOf(waiter), 1); }
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  child.stderr!.on("data", chunk => { stderr += chunk; });
  const waitEvent = (predicate: (e: SyncEvent) => boolean, timeoutMs = 40000) => new Promise<SyncEvent>((resolve, reject) => {
    const found = events.find(predicate);
    if (found) { resolve(found); return; }
    const timer = setTimeout(() => reject(new Error(`Android 事件超时；events=${JSON.stringify(events)} stderr=${stderr.slice(-800)}`)), timeoutMs);
    waiters.push({ predicate, resolve: event => { clearTimeout(timer); resolve(event); } });
  });
  const command = (payload: Record<string, unknown>) => child.stdin!.write(`${JSON.stringify(payload)}\n`);
  const stop = async () => {
    if (child.exitCode !== null) return;
    command({ cmd: "stop" });
    await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill(); resolve(); }, 5000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
  };
  return { waitEvent, command, stop, events, getStderr: () => stderr };
}

async function registerAndCreateNote(server: string) {
  const registration = await (await fetch(`${server}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  })).json() as { token: string };
  const headers = { Authorization: `Bearer ${registration.token}`, "Content-Type": "application/json" };
  const notebooks = await (await fetch(`${server}/api/notebooks`, { headers })).json() as Array<{ id: string }>;
  const createdResponse = await fetch(`${server}/api/notes`, {
    method: "POST", headers,
    body: JSON.stringify({ notebookId: notebooks[0].id, title: "三端同步", contentFormat: "markdown", content: "同步起点\n" }),
  });
  expect(createdResponse.status).toBe(201);
  const note = await createdResponse.json() as { id: string };
  return { token: registration.token, headers, noteId: note.id };
}

async function signIn(context: BrowserContext, server: string) {
  const page = await context.newPage();
  await page.addInitScript(v => {
    localStorage.setItem("i18nextLng", "zh-CN");
    localStorage.setItem("nowen-seen-version", v);
  }, version);
  await page.goto(server);
  await page.getByPlaceholder("admin", { exact: true }).fill(USERNAME);
  await page.locator("input[type=password]").fill(PASSWORD);
  await page.locator("button[type=submit]").click();
  await expect(page.getByPlaceholder("admin", { exact: true })).not.toBeVisible({ timeout: 30000 });
  return page;
}

/** 关掉 What's New 等全屏遮罩，否则会挡住编辑器点击。 */
async function dismissOverlays(page: Page) {
  const overlay = page.locator('[data-swipe-blocker="whats-new"]');
  if (!(await overlay.isVisible().catch(() => false))) return;
  await page.keyboard.press("Escape");
  const gone = await overlay.waitFor({ state: "hidden", timeout: 3000 }).then(() => true).catch(() => false);
  if (!gone) {
    await page.getByRole("button", { name: "关闭", exact: true }).first().click();
    await expect(overlay).not.toBeVisible({ timeout: 5000 });
  }
}

/** 打开笔记并等编辑器就绪；返回可键入的 CodeMirror 内容区。 */
async function openEditor(page: Page, server: string, noteId: string) {
  await page.goto(`${server}/notes/${noteId}`);
  await dismissOverlays(page);
  const editor = page.locator(".cm-editor").filter({ visible: true }).first();
  const source = editor.locator(".cm-content");
  await expect(source).toBeVisible({ timeout: 30000 });
  await dismissOverlays(page);
  return source;
}

/** 轮询对端正文，返回实际可见耗时。 */
async function waitForText(source: Locator, text: string, timeoutMs = 15000) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  for (;;) {
    const current = await source.innerText().catch(() => "");
    if (current.includes(text)) return Date.now() - startedAt;
    if (Date.now() > deadline) throw new Error(`对端在 ${timeoutMs}ms 内未出现 ${JSON.stringify(text)}；当前=${JSON.stringify(current.slice(0, 200))}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test("Web 端真实键入 → PC 端编辑器实时可见（真实 Chrome 双端）", async ({ browser, server }) => {
  const { headers, noteId } = await registerAndCreateNote(server);
  const note = { id: noteId };

  const webContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pcContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const web = await signIn(webContext, server);
  const pc = await signIn(pcContext, server);
  const webSource = await openEditor(web, server, note.id);
  const pcSource = await openEditor(pc, server, note.id);
  await expect(webSource).toContainText("同步起点");
  await expect(pcSource).toContainText("同步起点");

  // Web 端真实键盘输入
  await webSource.click();
  await web.keyboard.press("Control+End");
  const marker = `WEB-${Date.now()}`;
  await web.keyboard.type(marker, { delay: 30 });
  const webToPc = await waitForText(pcSource, marker, 20000);
  console.log(`[latency] Web 真实键入 → PC 编辑器可见: ${webToPc}ms`);
  expect(webToPc).toBeLessThan(10000);

  // 反向：PC 端真实键盘输入
  await pcSource.click();
  await pc.keyboard.press("Control+End");
  const reverse = `PC-${Date.now()}`;
  await pc.keyboard.type(reverse, { delay: 30 });
  const pcToWeb = await waitForText(webSource, reverse, 20000);
  console.log(`[latency] PC 真实键入 → Web 编辑器可见: ${pcToWeb}ms`);
  expect(pcToWeb).toBeLessThan(10000);

  // 服务端最终正文必须同时包含两端输入
  await expect.poll(async () => {
    const current = await (await fetch(`${server}/api/notes/${note.id}`, { headers })).json() as { content: string };
    return current.content.includes(marker) && current.content.includes(reverse);
  }, { timeout: 20000 }).toBe(true);

  await webContext.close();
  await pcContext.close();
});

test("三端同时在线：Web 键入 → Android 落库；Android 编辑 → Web/PC 编辑器可见", async ({ browser, server }) => {
  const { token, noteId } = await registerAndCreateNote(server);
  const android = startAndroid(server, token);
  try {
    await android.waitEvent(event => event.event === "ready");

    const webContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pcContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const web = await signIn(webContext, server);
    const pc = await signIn(pcContext, server);
    const webSource = await openEditor(web, server, noteId);
    const pcSource = await openEditor(pc, server, noteId);
    await expect(webSource).toContainText("同步起点");
    await expect(pcSource).toContainText("同步起点");

    // 1) Web 真实键入 → Android native SQLite
    const marker = `WEB3-${Date.now()}`;
    android.command({ cmd: "wait", noteId, text: marker });
    await webSource.click();
    await web.keyboard.press("Control+End");
    await web.keyboard.type(marker, { delay: 30 });
    const converged = await android.waitEvent(event => event.event === "converged" || event.event === "error", 45000);
    expect(converged.event).toBe("converged");
    console.log(`[latency] Web 真实键入 → Android native 落库: ${converged.ms}ms`);

    // 2) PC 端也应看到同一个 marker
    const webToPc = await waitForText(pcSource, marker, 20000);
    console.log(`[latency] Web 真实键入 → PC 编辑器可见: ${webToPc}ms`);

    // 3) Android 端编辑并推送 → Web 编辑器
    const androidText = `ANDROID-${Date.now()}`;
    android.command({ cmd: "edit", noteId, text: androidText });
    await android.waitEvent(event => event.event === "pushed", 20000);
    const androidToWeb = await waitForText(webSource, androidText, 25000);
    console.log(`[latency] Android 编辑 → Web 编辑器可见: ${androidToWeb}ms`);
    const androidToPc = await waitForText(pcSource, androidText, 20000);
    console.log(`[latency] Android 编辑 → PC 编辑器可见: ${androidToPc}ms`);

    await webContext.close();
    await pcContext.close();
  } finally {
    await android.stop();
  }
});

test("Web 与 PC 同时连续输入：两端正文一致，双方输入都不丢", async ({ browser, server }) => {
  const { noteId } = await registerAndCreateNote(server);
  const webContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pcContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const web = await signIn(webContext, server);
  const pc = await signIn(pcContext, server);
  const webSource = await openEditor(web, server, noteId);
  const pcSource = await openEditor(pc, server, noteId);
  await expect(webSource).toContainText("同步起点");

  const fromWeb = `W${Date.now().toString().slice(-6)}-`;
  const fromPc = `P${Date.now().toString().slice(-6)}-`;
  await webSource.click();
  await web.keyboard.press("Control+End");
  await pcSource.click();
  await pc.keyboard.press("Control+End");
  await Promise.all([
    web.keyboard.type(fromWeb.repeat(6), { delay: 10 }),
    pc.keyboard.type(fromPc.repeat(6), { delay: 10 }),
  ]);

  await waitForText(webSource, fromPc, 25000);
  await waitForText(pcSource, fromWeb, 25000);
  // innerText 里混着 y-codemirror 的协作光标装饰（对端用户名 + 零宽占位符），比较正文前剔除。
  const normalize = (raw: string) => raw.replace(/\s+/g, "").replaceAll(USERNAME, "").replace(/[⁠​﻿]/g, "");
  const webText = normalize(await webSource.innerText());
  const pcText = normalize(await pcSource.innerText());
  expect(webText).toBe(pcText);
  expect(webText.split(fromWeb).length - 1).toBe(6);
  expect(webText.split(fromPc).length - 1).toBe(6);
  console.log(`[result] 并发输入收敛一致，两端各 6 段标记均完整（正文 ${webText.length} 字符）`);
  await webContext.close();
  await pcContext.close();
});

test("PC 断网期间 Web 继续输入，网络恢复后 PC 自动补齐", async ({ browser, server }) => {
  const { noteId } = await registerAndCreateNote(server);
  const webContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pcContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const web = await signIn(webContext, server);
  const pc = await signIn(pcContext, server);
  const webSource = await openEditor(web, server, noteId);
  const pcSource = await openEditor(pc, server, noteId);
  await expect(pcSource).toContainText("同步起点");

  await pcContext.setOffline(true);
  await webSource.click();
  await web.keyboard.press("Control+End");
  const marker = `OFFLINE-${Date.now()}`;
  await web.keyboard.type(marker, { delay: 30 });
  await expect(webSource).toContainText(marker);
  await web.waitForTimeout(1500);

  await pcContext.setOffline(false);
  const caughtUp = await waitForText(pcSource, marker, 30000);
  console.log(`[latency] PC 断网恢复 → 补齐 Web 期间输入: ${caughtUp}ms（含重连）`);
  await webContext.close();
  await pcContext.close();
});
