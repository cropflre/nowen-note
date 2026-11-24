import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// The public share page renders rich-text JSON with its own renderer. Callouts, floating text boxes,
// columns and folding blocks used to fall through to their bare paragraphs.
const root = path.resolve("..");
const runtime = process.env.NOWEN_QA_NODE || (createRequire(import.meta.url)("electron") as string);
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const body = "Shared body text flows beside the floating box and keeps wrapping around it line after line. ".repeat(4);

test("share page shows callouts, text boxes, columns and folding blocks", async ({ page }) => {
  test.setTimeout(120_000);
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
  try {
    await expect.poll(() => fetch(`${url}/api/health`).then(response => response.ok).catch(() => false), { timeout: 30000, message: "Disposable backend starts" }).toBe(true);
    const token = (await (await page.request.post(`${url}/api/auth/login`, { data: { username: "v3_browser", password: "v3-browser-test-password" } })).json()).token as string;
    const headers = { Authorization: `Bearer ${token}` };
    const notebooks = await (await page.request.get(`${url}/api/notebooks`, { headers })).json();
    const created = await page.request.post(`${url}/api/notes`, { headers, data: {
      notebookId: notebooks[0].id, title: "Shared rich blocks", contentFormat: "tiptap-json",
      content: JSON.stringify({ type: "doc", content: [
        { type: "callout", attrs: { type: "green", icon: "" }, content: [paragraph("Green callout")] },
        { type: "callout", attrs: { type: "gray", icon: "", float: "right", width: 35 }, content: [paragraph("Boxed caption")] },
        paragraph(body),
        { type: "column_container", content: [
          { type: "column", content: [paragraph("Left column")] },
          { type: "column", content: [paragraph("Right column")] },
        ] },
        { type: "details", attrs: { open: true }, content: [
          { type: "detailsSummary", content: [{ type: "text", text: "Open summary" }] },
          { type: "detailsContent", content: [paragraph("Open body")] },
        ] },
        { type: "details", attrs: { open: false }, content: [
          { type: "detailsSummary", content: [{ type: "text", text: "Closed summary" }] },
          { type: "detailsContent", content: [paragraph("Closed body")] },
        ] },
      ] }),
    } });
    expect(created.status(), await created.text()).toBe(201);
    const note = (await created.json()) as { id: string };
    const share = await page.request.post(`${url}/api/shares`, { headers, data: { noteId: note.id, permission: "view" } });
    expect(share.ok(), await share.text()).toBe(true);
    const { shareToken } = (await share.json()) as { shareToken: string };

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${url}/share/${shareToken}`);
    const content = page.locator(".shared-note-content");
    await expect(content.getByText("Green callout")).toBeVisible({ timeout: 30000 });

    await expect(content.locator('div[data-type="callout"][data-callout-type="green"]')).toHaveCSS("background-color", "rgb(232, 246, 238)");
    const box = content.locator('div[data-type="callout"][data-float="right"]');
    await expect(box).toHaveCSS("float", "right");
    const layout = await page.evaluate(() => {
      const host = document.querySelector(".shared-note-content")!;
      const boxElement = host.querySelector('div[data-type="callout"][data-float]')!;
      const next = boxElement.nextElementSibling!;
      const range = document.createRange(); range.selectNodeContents(next);
      const firstLine = range.getClientRects()[0];
      const columns = Array.from(host.querySelectorAll(".prosemirror-column")).map(column => column.getBoundingClientRect());
      return {
        hostWidth: host.getBoundingClientRect().width, box: boxElement.getBoundingClientRect().toJSON(),
        lineTop: firstLine.top, lineRight: firstLine.right,
        columns: columns.map(rect => ({ left: rect.left, top: rect.top, bottom: rect.bottom })),
      };
    });
    expect(layout.box.width / layout.hostWidth).toBeGreaterThan(0.3);
    expect(layout.box.width / layout.hostWidth).toBeLessThan(0.4);
    expect(layout.lineTop).toBeLessThan(layout.box.bottom);
    expect(layout.lineRight).toBeLessThanOrEqual(layout.box.left + 1);
    expect(layout.columns[1].left).toBeGreaterThan(layout.columns[0].left);
    expect(Math.abs(layout.columns[1].top - layout.columns[0].top)).toBeLessThan(2);

    await expect(content.getByText("Open body")).toBeVisible();
    await expect(content.getByText("Closed body")).toBeHidden();
    await content.getByText("Closed summary").click();
    await expect(content.getByText("Closed body")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("shared-rich-blocks-desktop.png"), fullPage: true });

    // Dark theme keeps readable callout colours.
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(content.locator('div[data-type="callout"][data-callout-type="green"]')).toHaveCSS("background-color", "rgba(34, 197, 94, 0.16)");
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    // Phones: the text box stops floating and columns stack.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(box).toHaveCSS("float", "none");
    const stacked = await page.evaluate(() => Array.from(document.querySelectorAll(".shared-note-content .prosemirror-column")).map(column => column.getBoundingClientRect().toJSON()));
    expect(stacked[1].top).toBeGreaterThanOrEqual(stacked[0].bottom);
    await page.screenshot({ path: test.info().outputPath("shared-rich-blocks-phone.png"), fullPage: true });
  } catch (error) {
    console.log(logs.slice(-4000));
    throw error;
  } finally {
    if (server.exitCode === null) { const exited = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
