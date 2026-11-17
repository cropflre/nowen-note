import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// The AI conversation archive ships switched on; an administrator can turn it off (no entry, no API) and back on.
test("the AI conversation archive is on by default, an administrator can switch it off, and switching it back on restores it", async ({ page }) => {
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
    const token = (await (await page.request.post(`${url}/api/auth/login`, { data: { username: "v3_browser", password: "v3-browser-test-password" } })).json()).token as string;
    const headers = { Authorization: `Bearer ${token}` };
    expect((await page.request.post(`${url}/api/onboarding/welcome`, { headers })).ok()).toBe(true);

    // On by default on the server: public settings say so and the archive API answers.
    expect((await (await page.request.get(`${url}/api/settings`)).json()).feature_ai_memory_enabled).toBe("true");
    expect((await page.request.get(`${url}/api/ai-memory/capabilities`, { headers })).status()).toBe(200);

    await page.goto(url);
    await page.evaluate(version => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", version); }, uiVersion);
    await page.reload();
    await page.getByPlaceholder("admin", { exact: true }).fill("v3_browser");
    await page.locator("input[type=password]").fill("v3-browser-test-password");
    await page.locator("button[type=submit]").click();
    const settings = page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true });
    await expect(settings).toBeVisible({ timeout: 30000 });
    const entry = page.getByRole("button", { name: "Chat archive", exact: true });

    // On by default in the app: the sidebar entry opens the archive, which says how to save a conversation.
    await expect(entry.filter({ visible: true })).toBeVisible();
    await entry.filter({ visible: true }).click();
    const dialog = page.getByRole("dialog", { name: "AI conversation archive", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("No saved conversations yet.");
    await expect(dialog).toContainText("Save to Nowen");
    expect(await page.locator("body").innerText()).not.toContain("aiMemory.");
    await page.screenshot({ path: test.info().outputPath("archive-open.png") });
    await dialog.getByRole("button", { name: "Close AI conversation archive", exact: true }).click();

    // Off: the administrator finds the switch in Settings → Switches; the entry disappears without reloading,
    // the API refuses, and the setting survives a reload.
    const serverFlag = () => page.request.get(`${url}/api/settings`).then(response => response.json()).then(body => body.feature_ai_memory_enabled);
    const openSwitches = async () => {
      await settings.click();
      await page.getByRole("button", { name: "Switches", exact: true }).filter({ visible: true }).click();
    };
    const toggle = page.getByRole("checkbox", { name: /Enable AI conversation archive/ });
    await openSwitches();
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect.poll(serverFlag).toBe("false");
    await page.screenshot({ path: test.info().outputPath("switch-off.png") });
    await page.evaluate(() => window.dispatchEvent(new Event("nowen:close-settings")));
    await expect(entry).toHaveCount(0);
    const refused = await page.request.get(`${url}/api/ai-memory/capabilities`, { headers });
    expect(refused.status()).toBe(404);
    expect((await refused.json()).code).toBe("AI_MEMORY_DISABLED");
    await page.reload();
    await expect(settings).toBeVisible({ timeout: 30000 });
    await expect(entry).toHaveCount(0);

    // On again: the entry comes back without reloading and the API answers.
    await openSwitches();
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect.poll(serverFlag).toBe("true");
    await page.evaluate(() => window.dispatchEvent(new Event("nowen:close-settings")));
    await expect(entry.filter({ visible: true })).toBeVisible();
    expect((await page.request.get(`${url}/api/ai-memory/capabilities`, { headers })).status()).toBe(200);
  } finally {
    if (server.exitCode === null) { const exited = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
    await test.info().attach("disposable-backend-log", { body: logs.slice(-8000), contentType: "text/plain" });
  }
});
