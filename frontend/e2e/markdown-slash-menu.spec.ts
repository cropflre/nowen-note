import { test as base, expect, devices } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createServer, type ViteDevServer } from "vite";

const root = path.resolve("..");
const electron = createRequire(import.meta.url)("electron") as string;
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const test = base.extend<{ server: string }>({
  server: async ({ browserName }, provide) => {
    void browserName;
    // Reuse the production-app fixture; it requires this temp profile prefix.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-composer-browser-"));
    let backend: ChildProcess | undefined, devServer: ViteDevServer | undefined, logs = "";
    try {
      // Keep this run independent of other builds in the shared checkout.
      const frontend = path.join(directory, "frontend");
      fs.cpSync(path.join(root, "frontend/dist"), frontend, { recursive: true });
      const port = await new Promise<number>(resolve => {
        const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => {
          const port = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(port));
        });
      });
      const server = `http://127.0.0.1:${port}`;
      backend = spawn(electron, ["--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href, path.join(root, "backend/tests/task-composer-browser-server.ts")], {
        cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TASK_COMPOSER_PROFILE: directory, FRONTEND_DIST: frontend, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
      });
      backend.stdout?.on("data", chunk => { logs += chunk; }); backend.stderr?.on("data", chunk => { logs += chunk; });
      await expect.poll(() => fetch(`${server}/api/health`).then(r => r.ok).catch(() => false), { timeout: 20000 }).toBe(true);
      if (process.env.SLASH_TEST_DEV === "1") {
        devServer = await createServer({
          configFile: path.join(root, "frontend/vite.config.ts"),
          server: { host: "127.0.0.1", port: 0, proxy: {
            "/api": { target: server, changeOrigin: true },
            "/ws": { target: server.replace("http:", "ws:"), ws: true },
          } },
        });
        await devServer.listen();
        await provide(devServer.resolvedUrls!.local[0].replace(/\/$/, ""));
      } else {
        await provide(server);
      }
    } finally {
      await devServer?.close();
      if (backend && backend.exitCode === null) {
        const exited = new Promise<void>(resolve => backend!.once("exit", () => resolve())); backend.kill(); await exited;
      }
      fs.rmSync(directory, { recursive: true, force: true });
      if (backend?.exitCode && backend.exitCode !== 0) console.error(logs.slice(-1000));
    }
  },
});

for (const width of [1440, 390]) {
  test.describe(`Rich-text / commands at ${width}px`, () => {
    test.use({ hasTouch: width < 640, viewport: { width, height: 900 },
      ...(width < 640 ? { isMobile: true, userAgent: devices["Pixel 7"].userAgent } : {}),
    });

    test("menu preserves the input cursor, supports selection and repeated sessions", async ({ page, server }) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => {
        if (message.type() === "error" && /Maximum update depth exceeded/.test(message.text())) errors.push(message.text());
      });
      const password = "slash-browser-test-password";
      const registration = await page.request.post(`${server}/api/auth/register`, { data: { username: "rich_slash_user", password } });
      expect(registration.ok()).toBe(true);
      const account = await registration.json(), headers = { Authorization: `Bearer ${account.token}` };
      const notebooks = await (await page.request.get(`${server}/api/notebooks`, { headers })).json();
      const created = await page.request.post(`${server}/api/notes`, { headers, data: {
        notebookId: notebooks[0].id, title: "Rich slash commands", contentFormat: "tiptap-json",
        content: JSON.stringify({ type: "doc", content: [
          ...Array.from({ length: 20 }, (_, index) => ({ type: "paragraph", content: [{ type: "text", text: `Original paragraph ${index}` }] })),
          { type: "paragraph" },
        ] }),
      } });
      expect(created.status(), await created.text()).toBe(201);
      const note = await created.json();
      await page.addInitScript(version => { localStorage.setItem("i18nextLng", "zh-CN"); localStorage.setItem("nowen-seen-version", version); }, version);
      await page.goto(server);
      await page.getByPlaceholder("admin", { exact: true }).fill("rich_slash_user");
      await page.locator("input[type=password]").fill(password);
      await page.locator("button[type=submit]").click();
      if (process.env.SLASH_TEST_DEV === "1") {
        // StrictMode cancels the welcome-note effect before it writes its marker.
        await expect(page.getByPlaceholder("admin", { exact: true })).not.toBeVisible({ timeout: 20000 });
      } else {
        await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith("nowen:onboarding-welcome-opened:v1:")))).toBe(true);
      }
      await page.goto(`${server}/notes/${note.id}`);
      const editor = page.locator(".tiptap[contenteditable=true]").filter({ visible: true });
      await expect(editor).toBeVisible();
      await editor.locator("p").last().click();
      await page.keyboard.type("/");
      const first = page.getByRole("button", { name: /录音.*录制并保存/ });
      await expect(first).toBeVisible();
      // Keep the menu open across derived UI updates and the autosave response.
      await page.waitForTimeout(1800);
      await expect(first).toBeVisible();
      const menu = first.locator("../..");
      await expect(menu).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`rich-slash-${width}.png`) });
      if (width >= 640) {
        await first.hover();
        await page.mouse.wheel(0, 200);
        await expect(menu).toBeVisible();
      }
      if (width < 640) {
        await menu.getByRole("button", { name: /思维导图.*选择已有脑图/ }).tap();
      } else {
        await first.hover();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
      }
      const mindmapPicker = page.getByRole("dialog", { name: "插入思维导图", exact: true });
      await expect(mindmapPicker).toBeVisible();
      await expect(editor).not.toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
      await mindmapPicker.getByRole("textbox", { name: "新脑图名称", exact: true }).fill("Slash command mind map");
      await mindmapPicker.getByRole("button", { name: "新建并插入", exact: true }).click();
      await expect(mindmapPicker).not.toBeVisible();
      const embed = editor.locator('[data-nowen-block-embed^="mindmap:"]');
      await expect(embed).toHaveCount(1);
      await editor.locator("p").last().click();
      await page.keyboard.type("/");
      await expect(first).toBeVisible();
      await page.keyboard.type("h1");
      const heading = page.getByRole("button", { name: /标题 1.*大标题/ });
      await expect(heading).toBeVisible();
      if (width < 640) await heading.tap();
      else { await heading.hover(); await heading.click(); }
      await page.keyboard.type("Continued heading");
      await expect(editor.locator("h1")).toHaveText("Continued heading");
      await page.keyboard.press("Enter");
      await page.keyboard.type("/h2");
      const heading2 = page.getByRole("button", { name: /标题 2.*中标题/ });
      await expect(heading2).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(heading2).not.toBeVisible();
      await expect(editor).toContainText("/h2");
      for (let index = 0; index < 3; index += 1) await page.keyboard.press("Backspace");
      await page.keyboard.type("/h2");
      await expect(heading2).toBeVisible();
      await page.keyboard.press("Enter");
      await page.keyboard.type("Repeated heading");
      await expect(editor.locator("h2")).toHaveText("Repeated heading");
      await expect.poll(async () => (await (await page.request.get(`${server}/api/notes/${note.id}`, { headers })).json()).content)
        .toContain("Repeated heading");
      await page.reload();
      await expect(editor.locator("h1")).toHaveText("Continued heading");
      await expect(editor.locator("h2")).toHaveText("Repeated heading");
      await expect(editor.locator("p").first()).toHaveText("Original paragraph 0");
      await expect(embed).toHaveCount(1);
      for (const [query, label, text] of [
        ["code", /^代码块.*插入代码块/, "code remains editable"],
        ["mermaid", /^流程图.*Mermaid/, "graph TD"],
        ["脑图代码", /^Mermaid 脑图/, "mindmap"],
      ] as const) {
        await editor.locator(":scope > p").last().click();
        await page.keyboard.type(`/${query}`);
        const command = page.getByRole("button", { name: label });
        await expect(command).toBeVisible();
        if (width < 640) await command.tap();
        else await command.click();
        const block = editor.locator(".code-block-wrapper").last();
        await expect(block).toBeVisible();
        if (query === "code") await page.keyboard.type(text);
        await expect.poll(async () => {
          const saved = await (await page.request.get(`${server}/api/notes/${note.id}`, { headers })).json();
          const nodes = JSON.parse(saved.content).content as Array<{ type: string; content?: Array<{ text?: string }> }>;
          return nodes.some(node => node.type === "codeBlock" && node.content?.map(child => child.text || "").join("").includes(text));
        }).toBe(true);
        // An unresponsive editor cannot deliver animation-frame heartbeats.
        expect(await page.evaluate(() => new Promise<boolean>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))).toBe(true);
      }
      await expect(editor.locator(".mermaid-view-svg > svg")).toHaveCount(2);
      if (width >= 640) {
        const lastDiagram = editor.locator(".code-block-wrapper").last();
        // Inline previews hide the toolbar; double-click the diagram to edit its source.
        await lastDiagram.locator(".mermaid-preview-host").dblclick({ position: { x: 100, y: 70 } });
        await expect(lastDiagram.locator(".code-block-content")).toBeVisible();
        await lastDiagram.locator('button[title="切换到预览"]').click();
        await expect(editor.locator(".mermaid-view-svg > svg")).toHaveCount(2);
      }
      await page.reload();
      await expect(editor.locator(".code-block-wrapper")).toHaveCount(3);
      await expect(embed).toHaveCount(1);
      expect(errors).toEqual([]);
    });
  });
}

for (const width of [1440, 320, 390]) {
  test(`Markdown / commands preserve content and persist at ${width}px`, async ({ page, server }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && /Reading the editor layout|CodeMirror plugin crashed/.test(message.text())) errors.push(message.text()); });
    const password = "slash-browser-test-password";
    const registration = await page.request.post(`${server}/api/auth/register`, { data: { username: "slash_user", password } });
    expect(registration.ok()).toBe(true);
    const account = await registration.json(), headers = { Authorization: `Bearer ${account.token}` };
    const notebooks = await (await page.request.get(`${server}/api/notebooks`, { headers })).json();
    const created = await page.request.post(`${server}/api/notes`, { headers, data: {
      notebookId: notebooks[0].id, title: "Slash commands", contentFormat: "markdown", content: "original text\n\n",
    } });
    expect(created.status(), await created.text()).toBe(201);
    const note = await created.json();
    await page.addInitScript(version => { localStorage.setItem("i18nextLng", "zh-CN"); localStorage.setItem("nowen-seen-version", version); }, version);
    await page.goto(server);
    await page.getByPlaceholder("admin", { exact: true }).fill("slash_user");
    await page.locator("input[type=password]").fill(password);
    await page.locator("button[type=submit]").click();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith("nowen:onboarding-welcome-opened:v1:")))).toBe(true);
    await page.goto(`${server}/notes/${note.id}`);
    await page.setViewportSize({ width, height: 852 });
    const editor = page.locator(".cm-editor .cm-content").filter({ visible: true });
    await expect(editor).toBeVisible();
    await editor.click(); await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("/H1");
    const menu = page.getByRole("listbox", { name: "Markdown /" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await page.keyboard.type("heading");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/code");
    await expect(menu).toBeVisible();
    if (width < 640) await menu.getByRole("option").tap();
    else await page.keyboard.press("Tab");
    await page.keyboard.type("const answer = 42;");
    const expected = "original text\n\n# heading\n\n```\nconst answer = 42;\n```\n";
    // Existing Markdown commands separate a fenced block from preceding text.
    await expect.poll(async () => (await (await page.request.get(`${server}/api/notes/${note.id}`, { headers })).json()).content)
      .toContain("const answer = 42;");
    const saved = (await (await page.request.get(`${server}/api/notes/${note.id}`, { headers })).json()).content;
    expect(saved).toBe(expected);
    await page.reload();
    await expect(editor).toContainText("const answer = 42;");
    await editor.click(); await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("/tab");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(editor).toContainText("| 列1 | 列2 | 列3 |");
    await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(width - 8);
    expect(box.y).toBeGreaterThanOrEqual(8);
    expect(box.y + box.height).toBeLessThanOrEqual(852 - 8);
    await page.screenshot({ path: test.info().outputPath(`markdown-slash-${width}.png`) });
    await page.keyboard.press("Escape"); await expect(menu).not.toBeVisible();
    expect(errors).toEqual([]);
  });
}
