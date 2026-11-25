import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// The production build replaces the command palette with a lazy shell that renders nothing while closed.
// The shortcut runtime and help center must not depend on it: customized keys, the help dialog, toolbar
// hints and the Markdown editor's formatting shortcuts all have to work without opening the palette.
const root = path.resolve("..");
const runtime = process.env.NOWEN_QA_NODE || (createRequire(import.meta.url)("electron") as string);
const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

type JsonNode = { type?: string; attrs?: Record<string, unknown>; content?: JsonNode[]; text?: string; marks?: Array<{ type: string }> };
const paragraph = (text: string): JsonNode => ({ type: "paragraph", content: [{ type: "text", text }] });

test("shortcut customization, help and Markdown shortcuts work in the built app", async ({ page }) => {
  test.setTimeout(180_000);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-v3-browser-"));
  const frontend = path.join(directory, "frontend");
  fs.cpSync(path.join(root, "frontend/dist"), frontend, { recursive: true });
  const port = await new Promise<number>(resolve => { const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => { const value = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(value)); }); });
  const url = `http://127.0.0.1:${port}`;
  let logs = "";
  const server = spawn(runtime, ["--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href, path.join(root, "backend/tests/application-v3-browser-server.ts")], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", V3_BROWSER_PROFILE: directory, FRONTEND_DIST: frontend, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", chunk => { logs += chunk; }); server.stderr.on("data", chunk => { logs += chunk; });
  const uiVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  try {
    await expect.poll(() => fetch(`${url}/api/health`).then(response => response.ok).catch(() => false), { timeout: 30000, message: "Disposable backend starts" }).toBe(true);
    const token = (await (await page.request.post(`${url}/api/auth/login`, { data: { username: "v3_browser", password: "v3-browser-test-password" } })).json()).token as string;
    const headers = { Authorization: `Bearer ${token}` };
    const notebooks = await (await page.request.get(`${url}/api/notebooks`, { headers })).json();
    const create = async (data: Record<string, unknown>) => {
      const response = await page.request.post(`${url}/api/notes`, { headers, data: { notebookId: notebooks[0].id, ...data } });
      expect(response.status(), await response.text()).toBe(201);
      return (await response.json()) as { id: string };
    };
    const richNote = await create({ title: "Shortcut runtime", contentFormat: "tiptap-json", content: JSON.stringify({ type: "doc", content: [
      paragraph("Make this bold"), paragraph("Keep this plain"),
    ] }) });
    const markdownNote = await create({ title: "Shortcut runtime markdown", contentFormat: "markdown", content: "markdown target\n\nsecond line\n" });
    const savedRaw = async (id: string) => String((await (await page.request.get(`${url}/api/notes/${id}`, { headers })).json()).content);
    const savedRich = async () => (JSON.parse(await savedRaw(richNote.id)) as JsonNode).content ?? [];

    await page.goto(url);
    // Bold is customized to Ctrl/Cmd+Shift+U before the app starts.
    await page.evaluate(({ version, platformName }) => {
      localStorage.setItem("i18nextLng", "en");
      localStorage.setItem("nowen-seen-version", version);
      localStorage.setItem("nowen-shortcut-overrides:v1", JSON.stringify({ version: 1, platforms: { [platformName]: { bold: [["Mod", "Shift", "U"]] } } }));
    }, { version: uiVersion, platformName: platform });
    await page.reload();
    await page.getByPlaceholder("admin", { exact: true }).fill("v3_browser");
    await page.locator("input[type=password]").fill("v3-browser-test-password");
    await page.locator("button[type=submit]").click();
    await expect(page.getByPlaceholder("admin", { exact: true })).not.toBeVisible({ timeout: 30000 });

    await page.goto(`${url}/notes/${richNote.id}`);
    const rich = page.locator(".tiptap[contenteditable=true]").filter({ visible: true });
    await expect(rich).toBeVisible();

    // Help opens from the keyboard without ever opening the command palette.
    await rich.getByText("Make this bold", { exact: true }).click();
    await page.keyboard.press("ControlOrMeta+Shift+Slash");
    const help = page.getByRole("dialog", { name: "键盘快捷键" });
    await expect(help).toBeVisible();
    await expect(help).toContainText("居中对齐");
    await page.keyboard.press("Escape");
    await expect(help).toHaveCount(0);

    // Toolbar hints follow the customized key.
    await expect(page.locator('[data-shortcut-base-title="Bold"]').first()).toHaveAttribute("title", /^Bold \((⌘⇧U|Ctrl\+Shift\+U)\)$/);

    // ProseMirror reads the caret from the DOM shortly after a click; wait for it before pressing keys.
    const selected = () => page.evaluate(() => {
      const { state } = (document.querySelector(".ProseMirror") as unknown as { editor: { state: { doc: { textBetween(from: number, to: number): string }; selection: { from: number; to: number } } } }).editor;
      return state.doc.textBetween(state.selection.from, state.selection.to);
    });
    const selectStart = async (text: string, length: number) => {
      await rich.getByText(text, { exact: true }).click();
      await page.keyboard.press("Home");
      for (let index = 0; index < length; index++) await page.keyboard.press("Shift+ArrowRight");
      await expect.poll(selected).toBe(text.slice(0, length));
    };
    await selectStart("Make this bold", 4);
    await page.keyboard.press("ControlOrMeta+Shift+u");
    await expect.poll(async () => (await savedRich())[0].content?.[0], { timeout: 15000 }).toEqual({ type: "text", text: "Make", marks: [{ type: "bold" }] });
    // The replaced default no longer formats; a later centring proves the keys were processed.
    await selectStart("Keep this plain", 4);
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.press("ControlOrMeta+e");
    await expect.poll(async () => (await savedRich())[1].attrs?.textAlign, { timeout: 15000 }).toBe("center");
    expect(JSON.stringify((await savedRich())[1].content)).not.toContain("bold");

    // Markdown editor formatting only exists through the shortcut runtime.
    await page.goto(`${url}/notes/${markdownNote.id}`);
    const markdown = page.locator(".cm-editor .cm-content").filter({ visible: true });
    await expect(markdown).toBeVisible();
    await markdown.getByText("markdown target", { exact: true }).click();
    await page.keyboard.press("Home");
    for (let index = 0; index < "markdown".length; index++) await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ControlOrMeta+Shift+u");
    await expect.poll(() => savedRaw(markdownNote.id), { timeout: 15000 }).toContain("**markdown** target");
    await markdown.getByText("second line", { exact: true }).click();
    await page.keyboard.press("Home");
    for (let index = 0; index < "second".length; index++) await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ControlOrMeta+Shift+e");
    await expect.poll(() => savedRaw(markdownNote.id), { timeout: 15000 }).toContain("`second` line");
  } catch (error) {
    console.log(logs.slice(-4000));
    throw error;
  } finally {
    if (server.exitCode === null) { const exited = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
