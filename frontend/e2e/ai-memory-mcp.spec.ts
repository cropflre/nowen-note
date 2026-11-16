import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// The whole path: the person creates an "AI assistant (MCP)" source in the app, an assistant saves a
// conversation through the real embedded MCP with a notebook-limited token, and the archive appears in the app.
test("an AI assistant saves a conversation over MCP into a source the person created, and it shows in AI memory", async ({ page }) => {
  const root = path.resolve(".."), directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-v3-browser-"));
  const executable = process.env.NOWEN_QA_NODE || process.execPath;
  const port = await new Promise<number>(resolve => { const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => { const value = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(value)); }); });
  const url = `http://127.0.0.1:${port}`;
  let logs = "";
  const server = spawn(executable, ["--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href, path.join(root, "backend/tests/application-v3-browser-server.ts")], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", V3_BROWSER_PROFILE: directory, FRONTEND_DIST: path.join(root, "frontend/dist"), PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", chunk => { logs += chunk; }); server.stderr.on("data", chunk => { logs += chunk; });
  const uiVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  try {
    await expect.poll(() => fetch(`${url}/api/health`).then(response => response.ok).catch(() => false), { timeout: 30000, message: "Disposable backend starts" }).toBe(true);
    const session = (await (await page.request.post(`${url}/api/auth/login`, { data: { username: "v3_browser", password: "v3-browser-test-password" } })).json()).token as string;
    const headers = { Authorization: `Bearer ${session}` };
    expect((await page.request.post(`${url}/api/onboarding/welcome`, { headers })).ok()).toBe(true);
    // An administrator switches on the archive and the embedded MCP with write access.
    expect((await page.request.put(`${url}/api/settings`, { headers, data: { feature_ai_memory_enabled: true } })).ok()).toBe(true);
    expect((await page.request.put(`${url}/api/mcp`, { headers, data: { enabled: true, allowWrite: true, publicUrl: `${url}/mcp` } })).ok()).toBe(true);
    const notebook = await (await page.request.post(`${url}/api/notebooks`, { headers, data: { name: "AI conversations" } })).json() as { id: string };

    // The person creates an "AI assistant (MCP)" source for that notebook in the app.
    await page.goto(url);
    await page.evaluate(version => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", version); }, uiVersion);
    await page.reload();
    await page.getByPlaceholder("admin", { exact: true }).fill("v3_browser");
    await page.locator("input[type=password]").fill("v3-browser-test-password");
    await page.locator("button[type=submit]").click();
    await page.getByRole("button", { name: "AI memory", exact: true }).filter({ visible: true }).click();
    const dialog = page.getByRole("dialog", { name: "AI memory", exact: true });
    await dialog.getByRole("button", { name: "Connections & sync", exact: true }).click();
    await dialog.getByText("Create a source", { exact: true }).click();
    await dialog.getByLabel("Source type").selectOption({ label: "AI assistant (MCP)" });
    await dialog.getByLabel("Save to a personal notebook").selectOption(notebook.id);
    await dialog.getByLabel("I authorize connected AI assistants to save conversations to this notebook through MCP").check();
    await dialog.getByRole("button", { name: "Create source", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "AI assistant (MCP)", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("assistant-source.png") });

    // The assistant's connection: a token limited to that notebook, as Settings → Connect AI Agents creates it.
    const created = await (await page.request.post(`${url}/api/tokens`, { headers, data: { name: "MCP · Claude Code", resourceMode: "restricted", expiresAt: null,
      scopes: ["notes:read", "notes:write", "notebooks:read"], notebookResources: [{ notebookId: notebook.id, permission: "write", includeDescendants: false }] } })).json() as { token: string };
    const tool = async (name: string, args: unknown = {}) => {
      const response = await page.request.post(`${url}/mcp`, { headers: { Authorization: `Bearer ${created.token}`, Accept: "application/json, text/event-stream" },
        data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
      expect(response.status(), await response.text()).toBe(200);
      const result = (await response.json()).result;
      expect(result.isError ?? false, JSON.stringify(result)).toBe(false);
      return JSON.parse(result.content[0].text);
    };
    const sources = await tool("nowen_ai_archive_sources");
    expect(sources.sources).toHaveLength(1);
    const saved = await tool("nowen_ai_archive_save", { sourceId: sources.sources[0].id, conversationId: "claude-session-1", title: "Release checklist from Claude Code",
      messages: [{ id: "u1", role: "user", text: "List what to check before the release." }, { id: "a1", role: "assistant", text: "1. Run the full test suite.\n2. Check the changelog." }] });
    expect(saved.status).toBe("applied");
    expect((await tool("nowen_ai_archive_save", { sourceId: sources.sources[0].id, conversationId: "claude-session-1", title: "Release checklist from Claude Code",
      messages: [{ id: "u1", role: "user", text: "List what to check before the release." }, { id: "a1", role: "assistant", text: "1. Run the full test suite.\n2. Check the changelog." }] })).status).toBe("duplicate");

    // Back in the app, the archive is listed with its messages and note.
    await dialog.getByRole("button", { name: "Conversations", exact: true }).click();
    await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(dialog).toContainText("Release checklist from Claude Code");
    await expect(dialog).toContainText("2 messages");
    expect(await page.locator("body").innerText()).not.toContain("aiMemory.");
    await page.screenshot({ path: test.info().outputPath("archive-listed.png") });
    const note = await (await page.request.get(`${url}/api/notes/${saved.noteId}`, { headers })).json() as { notebookId: string; content: string };
    expect(note.notebookId).toBe(notebook.id);
    expect(note.content).toContain("Check the changelog.");
  } finally {
    if (server.exitCode === null) { const exited = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
    await test.info().attach("disposable-backend-log", { body: logs.slice(-8000), contentType: "text/plain" });
  }
});
