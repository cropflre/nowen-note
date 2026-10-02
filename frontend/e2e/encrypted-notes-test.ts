import { test as base, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const desktop = process.env.NOWEN_ENCRYPTED_ELECTRON === "1";
const file = process.env.NOWEN_ENCRYPTED_FILE === "1";
const fileBuild = path.resolve("node_modules/.cache/encrypted-notes-file");
let fileRoot = fileBuild;
export function encryptedFixtureUrl(name: string) {
  return file ? pathToFileURL(path.join(fileRoot, "benchmarks", name)).href
    : `http://127.0.0.1:5176/benchmarks/${name}`;
}
export const test = base.extend<{ desktopApp: ElectronApplication }>({
  desktopApp: async ({}, use, testInfo) => {
    if (!desktop) throw new Error("Use playwright.encrypted-notes-electron.config.ts for native window tests");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-encrypted-electron-"));
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    env.NOWEN_ENCRYPTED_TEST_PROFILE = directory;
    let app: ElectronApplication | undefined;
    try {
      if (file) {
        fileRoot = fileBuild;
        if (testInfo.project.name === "asar") {
          fileRoot = path.join(directory, "renderer.asar");
          await createRequire(import.meta.url)("@electron/asar").createPackage(fileBuild, fileRoot);
        }
        env.NOWEN_ENCRYPTED_RENDERER_ROOT = fileRoot;
      }
      app = await _electron.launch({
        executablePath: createRequire(import.meta.url)("electron"),
        args: [path.resolve("../scripts/encrypted-notes-electron-fixture.cjs")],
        env, chromiumSandbox: true, timeout: 15_000,
      });
      await use(app);
    } finally {
      try {
        const forbidden = ["PRIVATE_ENCRYPTED_M2_SENTINEL", "test-only-m2-password", "new-test-only-password", "PRIVATE_ENCRYPTED_M3_SENTINEL", "test-only-m3-password"];
        try {
          if (file && app) {
            const requests = await app.evaluate(() => JSON.stringify((globalThis as any).encryptedFixtureRequests));
            for (const marker of forbidden) expect(requests).not.toContain(marker);
          }
        } finally { await app?.close(); }
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
        scan(directory); expect(leaks).toEqual([]);
      }
      finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
  },
  ...(desktop ? {
    page: async ({ desktopApp }: { desktopApp: ElectronApplication }, use: (page: Page) => Promise<void>) => {
      const page = await desktopApp.firstWindow();
      await page.waitForLoadState();
      // Initial native activation must finish before a test enters passwords.
      await desktopApp.evaluate(({ app, BrowserWindow }) => {
        app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus();
      });
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
      await use(page);
    },
  } : {}),
});
export { expect };
