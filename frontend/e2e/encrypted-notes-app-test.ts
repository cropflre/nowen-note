import type { EncryptedTestGlobals } from "./encrypted-notes-runtime";
import { test as base, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve("..");
const executable = createRequire(import.meta.url)("electron") as string;
export const forbidden = ["PRIVATE_ENCRYPTED_APP_SENTINEL", "test-only-app-encryption-password"];
type Product = { app: ElectronApplication; page: Page; server: string; directory: string; restart: () => Promise<Page> };
export const test = base.extend<{ product: Product }>({
  product: async ({ browserName }, provide, testInfo) => {
    void browserName;
    const full = testInfo.project.name.endsWith("full");
    const packaged = testInfo.project.name === "packaged-full";
    const desktopExecutable = packaged ? process.env.NOWEN_ENCRYPTED_PACKAGED_EXECUTABLE : executable;
    if (!desktopExecutable || !fs.existsSync(desktopExecutable)) throw new Error("Build the encrypted acceptance app first");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-encrypted-app-"));
    let app: ElectronApplication | undefined; let backend: ChildProcess | undefined;
    let output = "";
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const socket = net.createServer(); socket.on("error", reject);
        socket.listen(0, "127.0.0.1", () => { const address = socket.address() as net.AddressInfo; socket.close(() => resolve(address.port)); });
      });
      let server = `http://127.0.0.1:${port}`;
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      env.NOWEN_ENCRYPTED_APP_PROFILE = directory; env.NOWEN_ENCRYPTED_APP_SERVER = server;
      delete env.NOWEN_DEV_BACKEND_URL; delete env.NOWEN_LITE_ONLY; delete env.NODE_OPTIONS;
      env.NOWEN_ENCRYPTED_APP_MODE = full ? "full" : "lite";
      if (!full) {
        backend = spawn(executable, ["--import", path.join(root, "backend/node_modules/tsx/dist/loader.mjs"), path.join(root, "backend/tests/encrypted-notes-app-server.ts")],
          { cwd: root, env: { ...env, ELECTRON_RUN_AS_NODE: "1", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
        backend.stdout?.on("data", (data) => { output += data.toString(); });
        backend.stderr?.on("data", (data) => { output += data.toString(); });
        await expect.poll(async () => {
          if (backend?.exitCode !== null) throw new Error(`Isolated backend exited: ${output.slice(-3000)}`);
          return fetch(`${server}/api/health`).then((response) => response.ok).catch(() => false);
        }, { timeout: 30_000 }).toBe(true);
      }
      delete env.ELECTRON_RUN_AS_NODE;
      async function start() {
        app = await _electron.launch({ executablePath: desktopExecutable, args: packaged ? [] : [path.join(root, "scripts/encrypted-notes-app-fixture.cjs")], env, cwd: root, chromiumSandbox: true });
        app.process().stdout?.on("data", (data) => { output += data.toString(); });
        app.process().stderr?.on("data", (data) => { output += data.toString(); });
        await expect.poll(async () => (await app!.windows()).find((window) => window.url().includes("/frontend/dist/index.html"))?.url(), { timeout: 20_000 }).not.toBeUndefined();
        const page = (await app.windows()).find((window) => window.url().includes("/frontend/dist/index.html"))!;
        await page.waitForLoadState();
        if (full) {
          await expect(page.getByRole("button", { name: "在根目录新建", exact: true })).toBeVisible();
          server = new URL(page.url()).searchParams.get("serverUrl")!;
          expect(new URL(server).hostname).toBe("127.0.0.1");
          expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(packaged);
          if (packaged) {
            expect(await app.evaluate(({ app }) => app.getAppPath())).toMatch(/app\.asar$/);
            expect(page.url()).toContain("/Contents/Resources/frontend/dist/index.html");
          }
        } else await expect(page.getByPlaceholder("admin", { exact: true })).toBeVisible();
        await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); const window = BrowserWindow.getAllWindows().find((entry: { webContents: { getURL(): string } }) => entry.webContents.getURL().includes("/frontend/dist/index.html")); window?.show(); window?.focus(); });
        await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
        // Failure evidence contains window lifecycle metadata only, never editor contents.
        await app.evaluate(({ BrowserWindow }) => {
          const events: EncryptedTestGlobals["encryptedAppWindowEvents"] = []; (globalThis as EncryptedTestGlobals).encryptedAppWindowEvents = events;
          for (const window of BrowserWindow.getAllWindows()) {
            const record = (event: string) => { events.push({ at: Date.now(), event, focused: window.isFocused(), visible: window.isVisible() }); };
            window.on("blur", () => record("blur"));
            window.on("focus", () => record("focus"));
            window.on("hide", () => record("hide"));
            window.on("show", () => record("show"));
            window.on("minimize", () => record("minimize"));
            window.on("restore", () => record("restore"));
          }
        });
        // UI preferences only; authentication stays on the real product login path.
        await page.evaluate(() => { localStorage.setItem("i18nextLng", "zh-CN"); localStorage.setItem("nowen-seen-version", "1.5.0"); });
        await page.reload();
        if (full) await expect(page.getByRole("button", { name: "在根目录新建", exact: true })).toBeVisible();
        return page;
      }
      const page = await start();
      const product: Product = { app: app!, page, server, directory, restart: async () => {
        const requests = await app!.evaluate(() => JSON.stringify((globalThis as EncryptedTestGlobals).encryptedAppRequests));
        for (const marker of forbidden) expect(requests).not.toContain(marker);
        expect(await app!.evaluate((_, markers) => (globalThis as EncryptedTestGlobals).encryptedAppScan(markers), forbidden)).toEqual([]);
        await app!.close(); app = undefined;
        if (full) await expect.poll(() => fetch(`${server}/api/health`).then(() => false).catch(() => true)).toBe(true);
        product.page = await start(); product.app = app!; product.server = server;
        return product.page;
      } };
      await provide(product);
    } finally {
      try {
        if (app) {
          if (testInfo.status !== testInfo.expectedStatus) {
            const events = await app.evaluate(() => (globalThis as EncryptedTestGlobals).encryptedAppWindowEvents || []);
            const evidence = testInfo.outputPath("native-window-lifecycle.json");
            fs.writeFileSync(evidence, JSON.stringify(events));
            await testInfo.attach("native-window-lifecycle.json", { path: evidence, contentType: "application/json" });
          }
          const requests = await app.evaluate(() => JSON.stringify((globalThis as EncryptedTestGlobals).encryptedAppRequests));
          for (const marker of forbidden) expect(requests).not.toContain(marker);
          expect(await app.evaluate((_, markers) => (globalThis as EncryptedTestGlobals).encryptedAppScan(markers), forbidden)).toEqual([]);
        }
      } finally {
        try {
          // A failed assertion may leave a dirty editor: force only fixture cleanup,
          // after request/database checks, without suppressing the original failure.
          if (app) await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); });
          await app?.close();
        } finally {
          if (backend && backend.exitCode === null && backend.signalCode === null) {
            const exited = new Promise<void>((resolve) => backend!.once("exit", () => resolve()));
            backend.kill("SIGTERM");
            const timer = setTimeout(() => backend?.kill("SIGKILL"), 5000);
            await exited; clearTimeout(timer);
          }
          try {
            const leaks: string[] = [];
            function scan(folder: string) {
              for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
                const file = path.join(folder, entry.name);
                if (entry.isDirectory()) scan(file);
                else if (entry.isFile()) {
                  const data = fs.readFileSync(file);
                  if (forbidden.some((marker) => data.includes(marker))) leaks.push(path.relative(directory, file));
                }
              }
            }
            scan(directory); for (const marker of forbidden) expect(output).not.toContain(marker);
            expect(leaks).toEqual([]);
          } finally { fs.rmSync(directory, { recursive: true, force: true }); }
        }
      }
    }
  },
});
export { expect };
