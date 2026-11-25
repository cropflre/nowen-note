import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// Phones begin a native text selection just before the long-press context menu. The guard that
// cancels it for the touched note card used to live inside the command palette, which the production
// build only renders while the palette is open, so it never ran. It must work in the built app.
const root = path.resolve("..");
const runtime = process.env.NOWEN_QA_NODE || (createRequire(import.meta.url)("electron") as string);

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("long-pressing a note card does not start text selection on phones", async ({ page }) => {
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
  const uiVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  try {
    await expect.poll(() => fetch(`${url}/api/health`).then(response => response.ok).catch(() => false), { timeout: 30000, message: "Disposable backend starts" }).toBe(true);

    await page.goto(url);
    await page.evaluate(version => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", version); }, uiVersion);
    await page.reload();
    await page.getByPlaceholder("admin", { exact: true }).fill("v3_browser");
    await page.locator("input[type=password]").fill("v3-browser-test-password");
    await page.locator("button[type=submit]").click();
    await expect(page.getByPlaceholder("admin", { exact: true })).not.toBeVisible({ timeout: 30000 });
    // The first login opens the welcome note on phones; go back to the guide's note list.
    const back = page.locator("[data-adaptive-editor-back]").filter({ visible: true });
    await expect(back).toBeVisible({ timeout: 30000 });
    await back.click();
    const titles = page.locator(".note-card-title").filter({ visible: true });
    await expect(titles.nth(1)).toBeVisible();

    const result = await page.evaluate(() => {
      const [touched, other] = Array.from(document.querySelectorAll<HTMLElement>(".note-card-title")).filter(element => element.getClientRects().length > 0);
      const touch = new Touch({ identifier: 1, target: touched, clientX: 20, clientY: 20 });
      touched.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
      const onTouched = new Event("selectstart", { bubbles: true, cancelable: true });
      touched.dispatchEvent(onTouched);
      const onOther = new Event("selectstart", { bubbles: true, cancelable: true });
      other.dispatchEvent(onOther);
      touched.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [touch] }));
      return { touched: onTouched.defaultPrevented, other: onOther.defaultPrevented };
    });
    expect(result).toEqual({ touched: true, other: false });
  } catch (error) {
    console.log(logs.slice(-4000));
    throw error;
  } finally {
    if (server.exitCode === null) { const exited = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
