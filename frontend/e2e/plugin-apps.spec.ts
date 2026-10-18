import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

test("1.5.3 host installs CLI package and runs an isolated, persistent app through production routes", async ({ page }) => {
  const root = path.resolve(".."), directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-v3-browser-"));
  expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()));
  const executable = process.env.NOWEN_QA_NODE || process.execPath;
  const port = await new Promise<number>(resolve => { const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => { const value = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(value)); }); });
  const url = `http://127.0.0.1:${port}`;
  let logs = "";
  const browserLogs: string[] = [];
  page.on("pageerror", error => browserLogs.push(error.message));
  page.on("console", message => { if (message.type() === "error") browserLogs.push(message.text()); });
  const launch = () => {
    const child = spawn(executable, ["--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href, path.join(root, "backend/tests/application-v3-browser-server.ts")], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", V3_BROWSER_PROFILE: directory, FRONTEND_DIST: path.join(root, "frontend/dist"), PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; }); return child;
  };
  let server = launch();
  try {
    await expect.poll(() => fetch(`${url}/api/health`).then(response => response.ok).catch(() => false), { timeout: 30000, message: "Disposable backend starts" }).toBe(true);
    const registered = await page.request.post(`${url}/api/auth/login`, { data: { username: "v3_browser", password: "v3-browser-test-password" } });
    expect(registered.ok()).toBe(true); const account = await registered.json();
    const headers = { Authorization: `Bearer ${account.token}` };
    const features = await (await page.request.get(`${url}/api/plugins/features`, { headers })).json();
    expect(features.currentNowenVersion).toBe("1.5.3");
    expect(features.applicationV3).toEqual({ core: true, appPages: true, dashboardWidgets: false, pluginData: false });
    expect(features.extensionsV21).toBe(false);
    const artifact = path.join(root, "examples/plugins/hello-nowen-app/dist/nowenlab.hello-app-0.1.0.nowen-plugin");
    expect(fs.existsSync(artifact), "Pack Hello Nowen App with the existing CLI before running this test").toBe(true);
    const uiVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
    await page.goto(url); await page.evaluate(version => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", version); }, uiVersion); await page.reload();
    await page.getByPlaceholder("admin", { exact: true }).fill("v3_browser"); await page.locator("input[type=password]").fill("v3-browser-test-password"); await page.locator("button[type=submit]").click();
    await expect(page.getByRole("textbox", { name: "Note Title", exact: true })).toHaveValue("欢迎使用 Nowen Note");
    await page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "Plugins", exact: true }).filter({ visible: true }).click();
    await page.locator('input[type="file"][accept=".nowen-plugin"]').setInputFiles(artifact);
    await expect(page.getByText("这是声明式零代码扩展", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: /继续安装|Continue install/, exact: true }).click();
    await expect(page.getByText("Isolated app UI code", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /确认权限并启用|Confirm permissions and enable/, exact: true }).click();
    await expect.poll(async () => (await (await page.request.get(`${url}/api/plugins/nowenlab.hello-app`, { headers })).json()).status).toBe("enabled");
    await page.evaluate(() => window.dispatchEvent(new Event("nowen:close-settings")));
    await page.getByRole("button", { name: "Apps", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "Pin to sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Hello Nowen App", exact: true }).filter({ visible: true }).first().click();
    const iframe = page.frameLocator('iframe[title="Hello Nowen App"]');
    await expect(iframe.locator("#status")).toHaveText("Saved data loaded");
    await iframe.getByLabel("Message", { exact: true }).fill("kept across app restarts"); await iframe.getByRole("button", { name: "Save", exact: true }).click();
    await expect(iframe.locator("#status")).toHaveText("Saved");
    const inner = page.frames().find(frame => frame.url().includes("/api/plugin-ui-v3/"))!;
    expect(await inner.evaluate(() => { let parentBlocked = false, storageBlocked = false; try { void parent.document.body; } catch { parentBlocked = true; } try { void localStorage.getItem("nowen-token"); } catch { storageBlocked = true; } return { parentBlocked, storageBlocked, native: typeof (window as any).nowenDesktop, node: typeof (window as any).require }; })).toEqual({ parentBlocked: true, storageBlocked: true, native: "undefined", node: "undefined" });
    expect(await inner.evaluate(() => new Promise<string>(resolve => {
      document.addEventListener("securitypolicyviolation", event => resolve(event.effectiveDirective), { once: true });
      void fetch("https://example.invalid/").catch(() => undefined);
    }))).toBe("connect-src");
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(iframe.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: test.info().outputPath("hello-app.png") });
    await iframe.getByRole("button", { name: "Back to notes", exact: true }).click(); await expect(page.locator('iframe[title="Hello Nowen App"]')).toHaveCount(0);
    const stopped = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill(); await stopped;
    server = launch();
    await expect.poll(() => fetch(`${url}/api/health`).then(response => response.ok).catch(() => false), { timeout: 30000 }).toBe(true);
    await page.reload();
    await page.getByRole("button", { name: "Hello Nowen App", exact: true }).filter({ visible: true }).click(); await expect(iframe.getByLabel("Message", { exact: true })).toHaveValue("kept across app restarts");
    expect((await page.request.post(`${url}/api/plugins/nowenlab.hello-app/disable`, { headers })).ok()).toBe(true);
    await expect(page.locator('iframe[title="Hello Nowen App"]')).toHaveCount(0);
    expect((await page.request.post(`${url}/api/plugins/nowenlab.hello-app/enable`, { headers })).ok()).toBe(true);
    await page.reload(); await page.getByRole("button", { name: "Hello Nowen App", exact: true }).filter({ visible: true }).click();
    await expect(iframe.getByLabel("Message", { exact: true })).toHaveValue("kept across app restarts");
    const reopened = page.frames().find(frame => frame.url().includes("/api/plugin-ui-v3/"))!;
    await reopened.evaluate(destination => { location.href = destination; }, `${url}/api/health?unexpected-frame-navigation=1`);
    await expect(page.locator('iframe[title="Hello Nowen App"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Reopen", exact: true }).click();
    await expect(iframe.getByLabel("Message", { exact: true })).toHaveValue("kept across app restarts");
    await page.evaluate(() => window.dispatchEvent(new Event("nowen:token-changed"))); await expect(page.locator('iframe[title="Hello Nowen App"]')).toHaveCount(0);
  } finally {
    if (server.exitCode === null) { const exited = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
    await test.info().attach("disposable-backend-log", { body: logs.slice(-8000), contentType: "text/plain" });
    await test.info().attach("browser-errors", { body: browserLogs.join("\n"), contentType: "text/plain" });
  }
});
