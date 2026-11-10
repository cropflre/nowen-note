import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// Extension Center acceptance through production routes. The disposable backend serves a
// signed Registry in-process (only the byte transport is replaced) and seeds one member.
test("Extension Center installs signed Registry plugins for admins and refuses members", async ({ page, browser }) => {
  const root = path.resolve(".."), directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-v3-browser-"));
  const executable = process.env.NOWEN_QA_NODE || process.execPath;
  const port = await new Promise<number>(resolve => { const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => { const value = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(value)); }); });
  const url = `http://127.0.0.1:${port}`;
  let logs = "";
  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  const server = spawn(executable, ["--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href, path.join(root, "backend/tests/application-v3-browser-server.ts")], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", V3_BROWSER_PROFILE: directory, V3_BROWSER_REGISTRY_FIXTURE: "1", FRONTEND_DIST: path.join(root, "frontend/dist"), PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", chunk => { logs += chunk; }); server.stderr.on("data", chunk => { logs += chunk; });
  const uiVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const signIn = async (target: Page, username: string, password: string) => {
    await target.goto(url);
    await target.evaluate(version => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", version); }, uiVersion);
    await target.reload();
    await target.getByPlaceholder("admin", { exact: true }).fill(username);
    await target.locator("input[type=password]").fill(password);
    await target.locator("button[type=submit]").click();
    await expect(target.getByRole("button", { name: "Apps", exact: true }).filter({ visible: true })).toBeVisible({ timeout: 30000 });
  };
  const openDiscover = async (target: Page) => {
    await target.getByRole("button", { name: "Apps", exact: true }).filter({ visible: true }).click();
    await target.getByRole("navigation", { name: "Extension Center navigation" }).getByRole("button", { name: "Discover", exact: true }).click();
    await expect(target.locator('[data-extension-card="plugin:fixture.writer"]')).toBeVisible();
  };
  try {
    await expect.poll(() => fetch(`${url}/api/health`).then(response => response.ok).catch(() => false), { timeout: 30000, message: "Disposable backend starts" }).toBe(true);
    const login = async (username: string, password: string) => (await (await page.request.post(`${url}/api/auth/login`, { data: { username, password } })).json()).token as string;
    const adminHeaders = { Authorization: `Bearer ${await login("v3_browser", "v3-browser-test-password")}` };
    const pluginStatus = async (id: string) => (await page.request.get(`${url}/api/plugins/${id}`, { headers: adminHeaders })).json().then(body => body.status as string | undefined);

    await signIn(page, "v3_browser", "v3-browser-test-password");
    await openDiscover(page);
    // The official source cannot be reached from the in-process transport: it fails visibly without hiding the fixture source.
    await expect(page.getByRole("alert").filter({ hasText: "Nowen Official Registry" })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search extensions" }).fill("markdown");
    const writer = page.locator('[data-extension-card="plugin:fixture.writer"]');
    await expect(page.locator("[data-extension-card]")).toHaveCount(1);
    await expect(writer).toContainText("Custom source");
    await page.getByRole("searchbox", { name: "Search extensions" }).fill("");

    // Install: the dialog lists the real declared permission and the server keeps the plugin quarantined.
    await writer.getByRole("button", { name: "Install", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("Read notes");
    await page.getByRole("dialog").getByRole("button", { name: "Continue install", exact: true }).click();
    await expect(writer.getByRole("button", { name: "Review and enable", exact: true })).toBeVisible();
    expect(await pluginStatus("fixture.writer")).toBe("quarantined");
    await writer.getByRole("button", { name: "Review and enable", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Confirm permissions and enable", exact: true }).click();
    await expect.poll(() => pluginStatus("fixture.writer")).toBe("enabled");
    await expect(writer).toContainText("Enabled");

    // A package whose bytes do not match the signed digest is refused and never registered.
    const tampered = page.locator('[data-extension-card="plugin:fixture.tampered"]');
    await tampered.getByRole("button", { name: "Install", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Continue install", exact: true }).click();
    await expect(page.getByText("Signature or checksum verification failed; the install was refused.")).toBeVisible();
    expect((await page.request.get(`${url}/api/plugins/fixture.tampered`, { headers: adminHeaders })).status()).toBe(404);

    // Details drawer: keyboard dismissible, granted permissions shown from server state.
    await writer.getByRole("button", { name: "Manage", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Fixture Writer" });
    await expect(drawer).toContainText("Granted");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    // Deep-link refresh keeps the page and the server state; then the real dark theme preference and 390px.
    await page.reload();
    await expect(writer).toContainText("Enabled");
    await page.screenshot({ path: test.info().outputPath("extension-center-light.png") });
    await page.evaluate(() => localStorage.setItem("nowen-note-theme", "dark"));
    await page.reload();
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
    await expect(writer).toContainText("Enabled");
    // Let the note sidebar finish its exit transition after the deep-link reload before capturing.
    await expect(page.getByText("No tags", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("extension-center-dark.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("extension-center-narrow-list.png") });
    await writer.getByRole("button", { name: "Manage", exact: true }).click();
    const narrowDrawer = page.getByRole("dialog", { name: "Fixture Writer" });
    await expect.poll(async () => Math.round((await narrowDrawer.boundingBox())?.x ?? -1)).toBe(0);
    const box = await narrowDrawer.boundingBox();
    expect(box && box.width <= 390 && Math.round(box.y) === 0 && Math.round(box.height) === 844).toBe(true);
    await page.screenshot({ path: test.info().outputPath("extension-center-narrow-drawer.png") });
    await page.keyboard.press("Escape");
    await page.evaluate(() => { localStorage.setItem("nowen-note-theme", "light"); localStorage.setItem("i18nextLng", "zh-CN"); });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.reload();
    await expect(page.getByRole("heading", { name: "扩展中心", level: 1 })).toBeVisible();
    await expect(writer).toContainText("已启用");
    await expect(page.getByText("暂无标签", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("extension-center-zh.png") });
    await page.evaluate(() => localStorage.setItem("i18nextLng", "en"));

    // Members can browse but get an honest "admin required" explanation, and the server refuses bypasses.
    const memberContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const member = await memberContext.newPage();
    try {
      await signIn(member, "v3_member", "v3-member-test-password");
      await openDiscover(member);
      const memberTampered = member.locator('[data-extension-card="plugin:fixture.tampered"]');
      await memberTampered.getByRole("button", { name: "Admin required", exact: true }).click();
      await expect(member.getByRole("dialog", { name: "Tampered Package" })).toContainText("Only server administrators can install");
      await member.keyboard.press("Escape");
      const memberHeaders = { Authorization: `Bearer ${await login("v3_member", "v3-member-test-password")}` };
      expect((await member.request.post(`${url}/api/plugins/ecosystem/install`, { headers: memberHeaders, data: { sourceId: "fixture-registry", pluginId: "fixture.tampered" } })).status()).toBe(403);
      expect((await member.request.post(`${url}/api/plugins/fixture.writer/disable`, { headers: memberHeaders })).status()).toBe(403);
      await member.getByRole("navigation", { name: "Extension Center navigation" }).getByRole("button", { name: "My plugins", exact: true }).click();
      await expect(member.getByText("Administrators handle installs, approvals and enabling.", { exact: false })).toBeVisible();
      await expect(member.locator('input[type="file"][accept=".nowen-plugin"]')).toHaveCount(0);
    } finally { await memberContext.close(); }
    expect(await pluginStatus("fixture.writer")).toBe("enabled");
  } finally {
    if (server.exitCode === null) { const exited = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
    await test.info().attach("disposable-backend-log", { body: logs.slice(-8000), contentType: "text/plain" });
    await test.info().attach("browser-errors", { body: browserErrors.join("\n"), contentType: "text/plain" });
  }
});
