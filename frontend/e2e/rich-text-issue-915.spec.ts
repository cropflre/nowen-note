import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// Issue #915 acceptance through production routes: Tab inserts four spaces, Ctrl/Cmd+E and
// Ctrl/Cmd+L align, and a floating text box can be dragged to the other side, resized and inserted.
const NBSP4 = "\u00a0".repeat(4);
const root = path.resolve("..");
const runtime = process.env.NOWEN_QA_NODE || (createRequire(import.meta.url)("electron") as string);

type JsonNode = { type?: string; attrs?: Record<string, unknown>; content?: JsonNode[]; text?: string; marks?: Array<{ type: string }> };
const paragraph = (text: string): JsonNode => ({ type: "paragraph", content: [{ type: "text", text }] });
const body = "Body text flows beside the floating text box and keeps wrapping around it line after line. ".repeat(4);

test("rich text: Tab spaces, alignment shortcuts and draggable text boxes", async ({ page }) => {
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
    const created = await page.request.post(`${url}/api/notes`, { headers, data: {
      notebookId: notebooks[0].id, title: "Issue 915", contentFormat: "tiptap-json",
      content: JSON.stringify({ type: "doc", content: [
        paragraph("Alpha paragraph"),
        paragraph("Bravo paragraph for alignment"),
        { type: "callout", attrs: { type: "gray", icon: "", float: "right", width: 40 }, content: [paragraph("Boxed caption")] },
        paragraph(body), paragraph("Charlie paragraph"), paragraph(body), paragraph("Delta paragraph"), paragraph(body),
      ] }),
    } });
    expect(created.status(), await created.text()).toBe(201);
    const note = (await created.json()) as { id: string };
    const saved = async (): Promise<JsonNode> => JSON.parse(String((await (await page.request.get(`${url}/api/notes/${note.id}`, { headers })).json()).content));
    const top = (doc: JsonNode) => doc.content ?? [];
    const boxes = (doc: JsonNode) => top(doc).filter(node => node.type === "callout");

    await page.goto(url);
    await page.evaluate(version => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", version); }, uiVersion);
    await page.reload();
    await page.getByPlaceholder("admin", { exact: true }).fill("v3_browser");
    await page.locator("input[type=password]").fill("v3-browser-test-password");
    await page.locator("button[type=submit]").click();
    await expect(page.getByPlaceholder("admin", { exact: true })).not.toBeVisible({ timeout: 30000 });
    await page.goto(`${url}/notes/${note.id}`);
    const rich = page.locator(".tiptap[contenteditable=true]").filter({ visible: true });
    await expect(rich).toBeVisible();
    const focusedInEditor = (target: Page) => target.evaluate(() => !!document.activeElement?.closest(".ProseMirror"));
    // ProseMirror reads the caret from the DOM shortly after a click; wait for it before pressing keys.
    const caretParent = () => page.evaluate(() => {
      const { state } = (document.querySelector(".ProseMirror") as unknown as { editor: { state: { doc: { textBetween(from: number, to: number): string }; selection: { from: number; to: number; $from: { parent: { textContent: string } } } } } }).editor;
      return { text: state.selection.$from.parent.textContent, selected: state.doc.textBetween(state.selection.from, state.selection.to) };
    });
    const placeCaret = async (text: string) => {
      await rich.getByText(text, { exact: true }).last().click();
      await expect.poll(async () => (await caretParent()).text.includes(text)).toBe(true);
    };
    // Select the first characters of a paragraph; Shift+End is platform-specific (macOS extends to the document end).
    const selectStart = async (text: string, length: number) => {
      await placeCaret(text);
      await page.keyboard.press("Home");
      for (let index = 0; index < length; index++) await page.keyboard.press("Shift+ArrowRight");
      await expect.poll(async () => (await caretParent()).selected).toBe(text.slice(0, length));
    };

    // Tab inserts four non-breaking spaces at the cursor and keeps focus; Shift+Tab removes them.
    await placeCaret("Alpha paragraph");
    await page.keyboard.press("Home");
    await page.keyboard.press("Tab");
    expect(await focusedInEditor(page)).toBe(true);
    await expect.poll(async () => top(await saved())[0].content?.[0]?.text, { timeout: 15000 }).toBe(`${NBSP4}Alpha paragraph`);
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+Tab");
    await expect.poll(async () => top(await saved())[0].content?.[0]?.text, { timeout: 15000 }).toBe("Alpha paragraph");
    await page.keyboard.press("Home");
    await page.keyboard.press("Tab");
    await expect.poll(async () => top(await saved())[0].content?.[0]?.text, { timeout: 15000 }).toBe(`${NBSP4}Alpha paragraph`);

    // Ctrl/Cmd+E centres, Ctrl/Cmd+L aligns left; inline code moved to Ctrl/Cmd+Shift+E.
    await placeCaret("Bravo paragraph for alignment");
    await page.keyboard.press("ControlOrMeta+e");
    await expect(rich.locator("p", { hasText: "Bravo paragraph" })).toHaveCSS("text-align", "center");
    await expect.poll(async () => top(await saved())[1].attrs?.textAlign, { timeout: 15000 }).toBe("center");
    await page.keyboard.press("ControlOrMeta+l");
    expect(await focusedInEditor(page)).toBe(true);
    await expect.poll(async () => top(await saved())[1].attrs?.textAlign, { timeout: 15000 }).toBe("left");
    await selectStart("Bravo paragraph for alignment", 5);
    await page.keyboard.press("ControlOrMeta+Shift+e");
    await expect.poll(async () => top(await saved())[1].content?.[0], { timeout: 15000 }).toEqual({ type: "text", text: "Bravo", marks: [{ type: "code" }] });

    // The text box floats right and the following paragraph wraps beside it.
    const outer = page.locator('.node-callout[data-text-box="right"]');
    await expect(outer).toHaveCSS("float", "right");
    const layout = await page.evaluate(() => {
      const editor = document.querySelector(".ProseMirror")!.getBoundingClientRect();
      const box = document.querySelector('.node-callout[data-text-box]')!.getBoundingClientRect();
      const next = document.querySelector('.node-callout[data-text-box]')!.nextElementSibling!;
      const range = document.createRange(); range.selectNodeContents(next);
      const firstLine = range.getClientRects()[0];
      return { editorWidth: editor.width, boxWidth: box.width, boxLeft: box.left, boxBottom: box.bottom, lineTop: firstLine.top, lineRight: firstLine.right };
    });
    expect(layout.boxWidth / layout.editorWidth).toBeGreaterThan(0.35);
    expect(layout.boxWidth / layout.editorWidth).toBeLessThan(0.45);
    expect(layout.lineTop).toBeLessThan(layout.boxBottom);
    expect(layout.lineRight).toBeLessThanOrEqual(layout.boxLeft + 1);
    await page.screenshot({ path: test.info().outputPath("issue-915-text-box-right.png") });

    // Drag the box by its grip into the left half next to "Delta paragraph": it moves there and floats left.
    await outer.hover();
    const grip = page.locator(".text-box-grip");
    await expect(grip).toBeVisible();
    const gripBox = (await grip.boundingBox())!;
    const delta = (await rich.getByText("Delta paragraph", { exact: true }).boundingBox())!;
    const editorBox = (await rich.boundingBox())!;
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(editorBox.x + editorBox.width * 0.2, delta.y + 2, { steps: 15 });
    await page.mouse.move(editorBox.x + editorBox.width * 0.2, delta.y + 3, { steps: 2 });
    await page.mouse.up();
    await expect.poll(async () => boxes(await saved()).map(box => box.attrs?.float), { timeout: 15000 }).toEqual(["left"]);
    const afterDrag = await saved();
    const boxIndex = top(afterDrag).findIndex(node => node.type === "callout");
    const deltaIndex = top(afterDrag).findIndex(node => node.content?.[0]?.text === "Delta paragraph");
    expect(boxIndex).toBeGreaterThan(2);
    expect(Math.abs(boxIndex - deltaIndex)).toBe(1);
    expect(JSON.stringify(top(afterDrag)[boxIndex].content)).toContain("Boxed caption");
    await expect(page.locator('.node-callout[data-text-box="left"]')).toHaveCSS("float", "left");

    // Resize from the inner (right) edge with the mouse, then fine-tune with the keyboard.
    const leftBox = page.locator('.node-callout[data-text-box="left"]');
    await leftBox.hover();
    const handle = page.locator(".text-box-resize");
    const handleBox = (await handle.boundingBox())!;
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 + editorBox.width * 0.15, handleBox.y + handleBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => Number(boxes(await saved())[0].attrs?.width), { timeout: 15000 }).toBeGreaterThanOrEqual(52);
    const widened = Number(boxes(await saved())[0].attrs?.width);
    await leftBox.hover();
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => Number(boxes(await saved())[0].attrs?.width), { timeout: 15000 }).toBe(widened - 5);

    // Insert a new text box from the slash menu at the end of the note.
    // Caret navigation keys differ per platform; this step is about the slash menu, so place the caret directly.
    await page.evaluate(() => (document.querySelector(".ProseMirror") as unknown as { editor: { commands: { focus(position: string): boolean } } }).editor.commands.focus("end"));
    await page.keyboard.press("Enter");
    await page.keyboard.type("/textbox");
    await expect(page.getByRole("button", { name: /Text box/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Inserted from slash");
    await expect.poll(async () => boxes(await saved()).map(box => [box.attrs?.float, box.attrs?.width]), { timeout: 15000 }).toEqual([["left", widened - 5], ["right", 40]]);
    expect(JSON.stringify(boxes(await saved())[1].content)).toContain("Inserted from slash");

    // Reopening goes through schema repair: layout, indentation and alignment all survive.
    await page.reload();
    await expect(rich).toBeVisible();
    await expect(page.locator('.node-callout[data-text-box="left"]')).toHaveCSS("float", "left");
    await expect(page.locator('.node-callout[data-text-box="right"]')).toHaveCSS("float", "right");
    // toHaveText normalizes whitespace, so compare the raw text to keep the non-breaking spaces in view.
    expect(await rich.locator("p").first().evaluate(element => element.textContent)).toBe(`${NBSP4}Alpha paragraph`);
    await page.screenshot({ path: test.info().outputPath("issue-915-after-reload.png"), fullPage: true });
  } catch (error) {
    console.log(logs.slice(-4000));
    throw error;
  } finally {
    if (server.exitCode === null) { const exited = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
