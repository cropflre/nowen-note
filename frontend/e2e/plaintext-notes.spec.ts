import { test as base, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve("..");
const electron = createRequire(import.meta.url)("electron") as string;
const test = base.extend<{ server: string }>({
  server: async ({ browserName }, provide) => {
    void browserName;
    // Reuse the production-app fixture; it requires this temp profile prefix.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-composer-browser-"));
    let backend: ChildProcess | undefined, logs = "";
    try {
      const port = await new Promise<number>(resolve => {
        const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => {
          const port = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(port));
        });
      });
      const server = `http://127.0.0.1:${port}`;
      backend = spawn(electron, ["--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href, path.join(root, "backend/tests/task-composer-browser-server.ts")], {
        cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TASK_COMPOSER_PROFILE: directory, FRONTEND_DIST: path.join(root, "frontend/dist"), PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
      });
      backend.stdout?.on("data", chunk => { logs += chunk; }); backend.stderr?.on("data", chunk => { logs += chunk; });
      await expect.poll(() => fetch(`${server}/api/health`).then(r => r.ok).catch(() => false), { timeout: 20000 }).toBe(true);
      await provide(server);
    } finally {
      if (backend && backend.exitCode === null) {
        const exited = new Promise<void>(resolve => backend!.once("exit", () => resolve())); backend.kill(); await exited;
      }
      fs.rmSync(directory, { recursive: true, force: true });
      if (backend?.exitCode && backend.exitCode !== 0) console.error(logs.slice(-1000));
    }
  },
});

for (const locale of ["zh-CN", "en"]) {
  test(`TXT creation, literal editing, reopen and download on desktop/mobile (${locale})`, async ({ page, server }) => {
    const accountResponse = await page.request.post(`${server}/api/auth/register`, { data: { username: "txt_user", password: "txt-browser-test-password" } });
    expect(accountResponse.ok()).toBe(true);
    const account = await accountResponse.json(), headers = { Authorization: `Bearer ${account.token}` };
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(server);
    await page.evaluate(language => { localStorage.setItem("i18nextLng", language); localStorage.setItem("nowen-seen-version", "1.5.1"); }, locale);
    await page.reload();
    await page.getByPlaceholder("admin", { exact: true }).fill("txt_user");
    await page.locator("input[type=password]").fill("txt-browser-test-password");
    await page.locator("button[type=submit]").click();
    await page.locator('[data-nowen-create-scope="root"]').filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: locale === "zh-CN" ? "纯文本文档（TXT）" : "Plain text document (TXT)", exact: true }).click();
    await page.locator('[data-knowledge-tree-inline-create] input').fill("TXT browser");
    await page.locator('[data-knowledge-tree-inline-create] input').press("Enter");
    const editor = page.locator("[data-plaintext-editor]");
    await expect(editor).toBeVisible();
    const tree = await (await page.request.get(`${server}/api/knowledge-tree/?workspaceId=personal`, { headers })).json();
    const noteId = tree.nodes.find((item: { title: string }) => item.title === "TXT browser").resourceId;
    await page.goto(`${server}/notes/${noteId}`);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      const source = `<script>window.__txtExecuted=true</script>\n# literal ${width}\n**bold**\n{"type":"doc"}\n\ttrailing  \n`;
      await editor.locator("textarea").fill(source);
      await expect.poll(async () => {
        return (await (await page.request.get(`${server}/api/notes/${noteId}`, { headers })).json()).content;
      }).toBe(source);
      expect(await page.evaluate(() => (window as unknown as { __txtExecuted?: boolean }).__txtExecuted)).toBeUndefined();
      await editor.screenshot({ path: test.info().outputPath(`txt-${locale}-${width}.png`) });
      const downloadPromise = page.waitForEvent("download");
      await editor.getByRole("button", { name: locale === "zh-CN" ? "导出 TXT" : "Export TXT" }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe("TXT browser.txt");
      expect(fs.readFileSync((await download.path())!, "utf8")).toBe(source);
      await page.reload();
      await expect(editor.locator("textarea")).toHaveValue(source);
    }
    const offlineSource = '  # offline\n<img src="blob:literal">\n![literal](file:///example)\n  ';
    await page.context().setOffline(true);
    await editor.locator("textarea").fill(offlineSource);
    await expect.poll(() => page.evaluate(id => {
      const queues = Object.keys(localStorage).filter(key => key.startsWith("nowen-offline-queue"));
      return queues.flatMap(key => JSON.parse(localStorage.getItem(key) || "[]")).find(item => item.noteId === id)?.body?.content;
    }, noteId)).toBe(offlineSource);
    expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`nowen-draft-${id}`) || "null")?.content, noteId)).toBe(offlineSource);
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(async () => (await (await page.request.get(`${server}/api/notes/${noteId}`, { headers })).json()).content, { timeout: 20000 }).toBe(offlineSource);
    await page.reload();
    await expect(editor.locator("textarea")).toHaveValue(offlineSource);
  });
}
