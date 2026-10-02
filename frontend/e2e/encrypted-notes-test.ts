import { test as base, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const desktop = process.env.NOWEN_ENCRYPTED_ELECTRON === "1";
export const test = base.extend<{ desktopApp: ElectronApplication }>({
  desktopApp: async ({}, use) => {
    if (!desktop) throw new Error("Use playwright.encrypted-notes-electron.config.ts for native window tests");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-encrypted-electron-"));
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    env.NOWEN_ENCRYPTED_TEST_PROFILE = directory;
    let app: ElectronApplication | undefined;
    try {
      app = await _electron.launch({
        executablePath: createRequire(import.meta.url)("electron"),
        args: [path.resolve("../scripts/encrypted-notes-electron-fixture.cjs")],
        env, chromiumSandbox: true, timeout: 15_000,
      });
      await use(app);
    } finally {
      try {
        await app?.close();
        const forbidden = ["PRIVATE_ENCRYPTED_M2_SENTINEL", "test-only-m2-password", "new-test-only-password", "PRIVATE_ENCRYPTED_M3_SENTINEL", "test-only-m3-password"];
        const leaks: string[] = [];
        function scan(folder: string) {
          for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            const file = path.join(folder, entry.name);
            if (entry.isDirectory()) scan(file);
            else if (entry.isFile() && forbidden.some((marker) => fs.readFileSync(file).includes(marker))) leaks.push(path.relative(directory, file));
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
      await use(page);
    },
  } : {}),
});
export { expect };
