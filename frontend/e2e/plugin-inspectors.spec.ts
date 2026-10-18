import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

test("installed V3 inspector follows resource selection and retires old credentials", async ({ page }) => {
  const root = path.resolve(".."), directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-v3-browser-inspector-"));
  const port = await new Promise<number>(resolve => { const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => { const port = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(port)); }); });
  const url = `http://127.0.0.1:${port}`;
  let logs = "";
  const server = spawn(process.env.NOWEN_QA_NODE || process.execPath, ["--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href, path.join(root, "backend/tests/application-v3-browser-server.ts")], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", V3_BROWSER_PROFILE: directory, FRONTEND_DIST: path.join(root, "frontend/dist"), PORT: String(port), NOWEN_EXTENSION_V3_INSPECTORS: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", value => { logs += value; }); server.stderr.on("data", value => { logs += value; });
  try {
    await expect.poll(() => fetch(`${url}/api/health`).then(r => r.ok).catch(() => false), { timeout: 30000 }).toBe(true);
    const account = await (await page.request.post(`${url}/api/auth/login`, { data: { username: "v3_browser", password: "v3-browser-test-password" } })).json();
    const headers = { Authorization: `Bearer ${account.token}` };
    const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
    await page.goto(url); await page.evaluate(version => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", version); }, version); await page.reload();
    await page.getByPlaceholder("admin", { exact: true }).fill("v3_browser"); await page.locator("input[type=password]").fill("v3-browser-test-password"); await page.locator("button[type=submit]").click();
    await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue("欢迎使用 Nowen Note");
    await expect(page.getByRole("button", { name: "Plugin inspector", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Apps", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "Manage apps", exact: true }).click();
    await page.locator('input[type="file"][accept=".nowen-plugin"]').setInputFiles(path.join(root, "examples/plugins/resource-inspector/dist/nowenlab.resource-inspector-0.1.0.nowen-plugin"));
    await page.getByRole("button", { name: /继续安装|Continue install/, exact: true }).click();
    await page.getByRole("button", { name: /确认权限并启用|Confirm permissions and enable/, exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(`${url}/api/plugins/nowenlab.resource-inspector`, { headers })).json()).status).toBe("enabled");
    await page.goto(url);
    await page.getByRole("button", { name: /^欢迎使用 Nowen Note/ }).filter({ visible: true }).first().click();
    await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue("欢迎使用 Nowen Note");
    const created = page.waitForResponse(r => r.url().includes("/home/session") && r.status() === 201);
    await page.getByRole("button", { name: "Plugin inspector", exact: true }).filter({ visible: true }).click();
    const session = await (await created).json();
    const frame = page.frameLocator('iframe[title="Resource Inspector"]');
    await expect(frame.locator("#status")).toHaveText("Ready");
    await expect(frame.locator("#resource-title")).toHaveText("欢迎使用 Nowen Note");
    await expect(frame.locator('[data-field="type"]')).toHaveText("note");
    await expect(frame.locator('[data-field="content"]')).toHaveCount(0);
    const oldId = await frame.locator('[data-field="id"]').textContent();
    const notes = await (await page.request.get(`${url}/api/notes`, { headers })).json();
    const first = notes.find((note: any) => note.id === oldId);
    const nextResponse = await page.request.post(`${url}/api/notes`, { headers, data: { notebookId: first.notebookId, title: "Inspector second note", content: "Private text", contentFormat: "markdown" } });
    expect(nextResponse.ok()).toBe(true); const next = await nextResponse.json();
    await page.evaluate(noteId => window.dispatchEvent(new CustomEvent("nowen:open-note-link", { detail: { noteId, blockId: null, href: `nowen://note/${noteId}` } })), next.id);
    await expect(page.getByRole("dialog", { name: "Plugin inspector", exact: true })).toHaveCount(0);
    await expect.poll(async () => (await page.request.post(`${url}/api/plugins/app-sessions/${session.instanceId}/call`, { headers, data: { protocol: "nowen.plugin-ui.v3", kind: "request", pluginId: session.pluginId, instanceId: session.instanceId, nonce: session.nonce, requestId: "retired", method: "inspector.getResource", params: {} } })).status()).not.toBe(200);
    await page.getByRole("button", { name: "Plugin inspector", exact: true }).filter({ visible: true }).click();
    await expect(frame.locator("#resource-title")).toHaveText("Inspector second note");
    await page.evaluate(() => document.documentElement.classList.add("dark")); await expect(frame.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: test.info().outputPath("inspector-note-dark.png") });
    await page.getByRole("button", { name: "Close inspector", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Plugin inspector", exact: true }).filter({ visible: true }).click();
    await expect(frame.locator("#resource-title")).toHaveText("Inspector second note");
    await page.getByRole("button", { name: "Close inspector", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 960 });
    const taskResponse = await page.request.post(`${url}/api/tasks`, { headers, data: { title: "Inspector task" } }); expect(taskResponse.ok()).toBe(true);
    await page.getByRole("button", { name: "Tasks", exact: true }).filter({ visible: true }).click();
    await page.getByText("Inspector task", { exact: true }).first().click();
    await page.getByRole("button", { name: "Plugin inspector", exact: true }).filter({ visible: true }).click();
    await expect(frame.locator('[data-field="type"]')).toHaveText("task");
    await expect(frame.locator("#resource-title")).toHaveText("Inspector task");
    await page.getByRole("button", { name: "Close inspector", exact: true }).click();
    const upload = await page.request.post(`${url}/api/files/upload`, { headers, multipart: { file: { name: "inspector-file.txt", mimeType: "text/plain", buffer: Buffer.from("Never expose these bytes") } } });
    expect(upload.status()).toBe(201);
    await page.getByRole("button", { name: "Files", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "inspector-file.txt", exact: true }).click();
    await page.getByRole("button", { name: "Plugin inspector", exact: true }).filter({ visible: true }).click();
    await expect(frame.locator('[data-field="type"]')).toHaveText("attachment");
    await expect(frame.locator("#resource-title")).toHaveText("inspector-file.txt");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.getByRole("dialog", { name: "Plugin inspector", exact: true }).evaluate(element => element.getBoundingClientRect().width <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("inspector-attachment-narrow.png") });
    expect((await page.request.post(`${url}/api/plugins/nowenlab.resource-inspector/disable`, { headers })).ok()).toBe(true);
    await expect(page.locator('iframe[title="Resource Inspector"]')).toHaveCount(0);
  } finally {
    if (server.exitCode === null) { const exited = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
    await test.info().attach("inspector-host-log", { body: logs.slice(-10000), contentType: "text/plain" });
  }
});
