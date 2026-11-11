import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// Editor action acceptance through production routes: the same packed plugins run in the rich-text and
// Markdown editors, results are saved and undoable, previews gate writes and stale results are refused.
test("editor actions run in both editors, save, undo and refuse stale results", async ({ page }) => {
  test.setTimeout(180_000);
  const root = path.resolve(".."), directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-v3-browser-"));
  const executable = process.env.NOWEN_QA_NODE || process.execPath;
  const port = await new Promise<number>(resolve => { const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => { const value = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(value)); }); });
  const url = `http://127.0.0.1:${port}`;
  let logs = "";
  const server = spawn(executable, ["--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href, path.join(root, "backend/tests/application-v3-browser-server.ts")], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", V3_BROWSER_PROFILE: directory, V3_BROWSER_AI_FIXTURE: "1", NOWEN_EDITOR_ACTIONS: "1", FRONTEND_DIST: path.join(root, "frontend/dist"), PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", chunk => { logs += chunk; }); server.stderr.on("data", chunk => { logs += chunk; });
  const uiVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  try {
    await expect.poll(() => fetch(`${url}/api/health`).then(response => response.ok).catch(() => false), { timeout: 30000, message: "Disposable backend starts" }).toBe(true);
    const token = (await (await page.request.post(`${url}/api/auth/login`, { data: { username: "v3_browser", password: "v3-browser-test-password" } })).json()).token as string;
    const headers = { Authorization: `Bearer ${token}` };
    for (const [folder, id] of [["text-tools", "community-sample.text-tools"], ["ai-text-assistant", "nowenlab.ai-text-assistant"]]) {
      const artifact = path.join(root, `examples/plugins/${folder}/dist/${id}-1.0.0.nowen-plugin`);
      expect(fs.existsSync(artifact), `Pack ${folder} with the existing CLI before running this test`).toBe(true);
      const installed = await page.request.post(`${url}/api/plugins/install`, { headers, multipart: { file: { name: path.basename(artifact), mimeType: "application/zip", buffer: fs.readFileSync(artifact) } } });
      expect(installed.status(), await installed.text()).toBe(201);
      expect((await page.request.put(`${url}/api/plugins/${id}/permissions`, { headers, data: { granted: [] } })).ok()).toBe(true);
      expect((await page.request.post(`${url}/api/plugins/${id}/enable`, { headers })).ok()).toBe(true);
    }
    const notebooks = await (await page.request.get(`${url}/api/notebooks`, { headers })).json();
    const create = async (data: Record<string, unknown>) => {
      const response = await page.request.post(`${url}/api/notes`, { headers, data: { notebookId: notebooks[0].id, ...data } });
      expect(response.status(), await response.text()).toBe(201);
      return (await response.json()) as { id: string; version: number };
    };
    const markdownNote = await create({ title: "Markdown actions", contentFormat: "markdown", content: "Opening line\n\nselect me please\n\nsecond target\n\nthird target\n" });
    const richNote = await create({ title: "Rich actions", contentFormat: "tiptap-json", content: JSON.stringify({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "rich target" }] }, { type: "paragraph" },
    ] }) });
    const saved = async (id: string) => String((await (await page.request.get(`${url}/api/notes/${id}`, { headers })).json()).content);

    await page.goto(url);
    await page.evaluate(version => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", version); }, uiVersion);
    await page.reload();
    await page.getByPlaceholder("admin", { exact: true }).fill("v3_browser");
    await page.locator("input[type=password]").fill("v3-browser-test-password");
    await page.locator("button[type=submit]").click();
    await expect(page.getByPlaceholder("admin", { exact: true })).not.toBeVisible({ timeout: 30000 });

    // Markdown: the plugin slash command inserts a saved, undoable block.
    await page.goto(`${url}/notes/${markdownNote.id}`);
    const markdown = page.locator(".cm-editor .cm-content").filter({ visible: true });
    await expect(markdown).toBeVisible();
    await markdown.click(); await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("/meeting");
    const slash = page.getByRole("listbox", { name: "Markdown /" });
    await expect(slash.getByRole("option", { name: /会议纪要模板/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(markdown).toContainText("会议纪要");
    await expect.poll(() => saved(markdownNote.id), { timeout: 15000 }).toContain("## 会议纪要");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(markdown).not.toContainText("会议纪要");
    await expect.poll(() => saved(markdownNote.id), { timeout: 15000 }).not.toContain("会议纪要");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(markdown).toContainText("会议纪要");
    await expect.poll(() => saved(markdownNote.id), { timeout: 15000 }).toContain("## 会议纪要");

    const selectLine = async (text: string) => {
      await markdown.getByText(text, { exact: true }).click();
      await page.keyboard.press("Home"); await page.keyboard.press("Shift+End");
    };
    const runFromSelection = async (label: RegExp) => {
      await page.locator('[data-editor-actions-placement="editor.selection"]').filter({ visible: true }).click();
      await page.getByRole("menuitem", { name: label }).click();
    };
    // Direct replacement of the selection.
    await selectLine("select me please");
    await runFromSelection(/用引号包围/);
    await expect.poll(() => saved(markdownNote.id), { timeout: 15000 }).toContain("“select me please”");
    // Confirmation first: nothing is written until the preview is accepted.
    await selectLine("second target");
    await runFromSelection(/行转列表/);
    const preview = page.getByRole("dialog");
    await expect(preview.getByRole("heading", { name: "Preview: 行转列表" })).toBeVisible();
    expect(await saved(markdownNote.id)).not.toContain("- second target");
    await preview.getByRole("button", { name: "Replace selection", exact: true }).click();
    await expect.poll(() => saved(markdownNote.id), { timeout: 15000 }).toContain("- second target");
    // AI prompt action: preview, then replace with AI provenance kept in the saved Markdown.
    await selectLine("third target");
    await runFromSelection(/AI 润色/);
    await expect(page.getByRole("status").filter({ hasText: "Running" })).toBeVisible();
    await expect(preview.getByText("Polished: third target")).toBeVisible({ timeout: 15000 });
    await preview.getByRole("button", { name: "Replace selection", exact: true }).click();
    await expect.poll(() => saved(markdownNote.id), { timeout: 15000 }).toContain("Polished: third target");
    expect(await saved(markdownNote.id)).toContain("nowen-aigc");
    // Editing the selection while the AI runs makes the result stale: it is shown, never written.
    await selectLine("Opening line");
    await runFromSelection(/AI 润色/);
    await page.keyboard.type("Changed meanwhile");
    await expect(preview.getByText("Polished: Opening line")).toBeVisible({ timeout: 15000 });
    await preview.getByRole("button", { name: "Replace selection", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "The note changed, so nothing was written" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).last().click();
    await expect.poll(() => saved(markdownNote.id), { timeout: 15000 }).toContain("Changed meanwhile");
    expect(await saved(markdownNote.id)).not.toContain("Polished: Opening line");

    // Rich text: the very same packed commands.
    await page.goto(`${url}/notes/${richNote.id}`);
    const rich = page.locator(".tiptap[contenteditable=true]").filter({ visible: true });
    await expect(rich).toBeVisible();
    await rich.locator("p").last().click();
    await page.keyboard.type("/meeting");
    await page.getByRole("button", { name: /会议纪要模板/ }).click();
    await expect(rich.locator("h2", { hasText: "会议纪要" })).toBeVisible();
    await expect.poll(() => saved(richNote.id), { timeout: 15000 }).toContain("会议纪要");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(rich.locator("h2", { hasText: "会议纪要" })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(rich.locator("h2", { hasText: "会议纪要" })).toBeVisible();
    await rich.getByText("rich target", { exact: true }).click();
    await page.keyboard.press("End"); await page.keyboard.press("Shift+Home");
    await page.locator('[data-editor-actions-placement="editor.selection"]').filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: /转为大写/ }).click();
    await expect(rich).toContainText("RICH TARGET");
    await expect.poll(() => saved(richNote.id), { timeout: 15000 }).toContain("RICH TARGET");
    await page.screenshot({ path: test.info().outputPath("editor-actions-rich.png") });

    // Narrow screens: the toolbar menu stays inside the viewport.
    await page.setViewportSize({ width: 390, height: 844 });
    // The compact mobile strip keeps extra tools behind "More", like the existing insert tools.
    await page.locator('[data-mobile-editor-toolbar="compact"]').getByRole("button", { name: "More", exact: true }).click();
    const toolbarMenu = page.locator('[data-mobile-editor-toolbar="expanded"] [data-editor-actions-placement="editor.toolbar.actions"]');
    await toolbarMenu.scrollIntoViewIfNeeded();
    await expect(toolbarMenu).toBeVisible();
    await toolbarMenu.click();
    const box = (await page.getByRole("menu").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(390 - 8);
    await page.screenshot({ path: test.info().outputPath("editor-actions-narrow-menu.png") });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 960 });

    // Locked notes are read-only: no extension menus are offered at all.
    const current = await (await page.request.get(`${url}/api/notes/${markdownNote.id}`, { headers })).json();
    expect((await page.request.put(`${url}/api/notes/${markdownNote.id}`, { headers, data: { isLocked: 1, version: current.version } })).ok()).toBe(true);
    await page.goto(`${url}/notes/${markdownNote.id}`);
    await expect(page.locator(".cm-editor .cm-content").filter({ visible: true })).toBeVisible();
    await expect(page.locator("[data-editor-actions-placement]")).toHaveCount(0);
  } finally {
    if (server.exitCode === null) { const exited = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
    await test.info().attach("disposable-backend-log", { body: logs.slice(-8000), contentType: "text/plain" });
  }
});
