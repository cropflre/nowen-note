import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// Workbench acceptance through production routes: built-in cards on real notes/tasks data,
// layout persistence, dormant plugin cards, narrow/dark layouts and per-account isolation.
test("workbench cards use real data, persist layouts and keep dormant plugin cards", async ({ page, browser }) => {
  const root = path.resolve(".."), directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-v3-browser-"));
  const executable = process.env.NOWEN_QA_NODE || process.execPath;
  const port = await new Promise<number>(resolve => { const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => { const value = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(value)); }); });
  const url = `http://127.0.0.1:${port}`;
  let logs = "";
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
    await expect(target.getByRole("button", { name: "Dashboard", exact: true }).filter({ visible: true })).toBeVisible({ timeout: 30000 });
  };
  const card = (target: Page, id: string) => target.locator(`[data-widget-id="${id}"]`);
  try {
    await expect.poll(() => fetch(`${url}/api/health`).then(response => response.ok).catch(() => false), { timeout: 30000, message: "Disposable backend starts" }).toBe(true);
    const login = async (username: string, password: string) => (await (await page.request.post(`${url}/api/auth/login`, { data: { username, password } })).json()).token as string;
    const headers = { Authorization: `Bearer ${await login("v3_browser", "v3-browser-test-password")}` };
    // Install the CLI-packed Hello app (which declares dashboard widgets) through the production install route.
    const artifact = path.join(root, "examples/plugins/hello-nowen-app/dist/nowenlab.hello-app-0.1.0.nowen-plugin");
    expect(fs.existsSync(artifact), "Pack Hello Nowen App with the existing CLI before running this test").toBe(true);
    const installed = await page.request.post(`${url}/api/plugins/install`, { headers, multipart: { file: { name: path.basename(artifact), mimeType: "application/zip", buffer: fs.readFileSync(artifact) } } });
    expect(installed.status(), await installed.text()).toBe(201);
    expect((await page.request.put(`${url}/api/plugins/nowenlab.hello-app/permissions`, { headers, data: { granted: ["plugin-storage:read", "plugin-storage:write"] } })).ok()).toBe(true);
    expect((await page.request.post(`${url}/api/plugins/nowenlab.hello-app/enable`, { headers })).ok()).toBe(true);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const task = await (await page.request.post(`${url}/api/tasks`, { headers, data: { title: "Workbench acceptance task", dueDate: today } })).json();
    expect(typeof task.id).toBe("string");

    await signIn(page, "v3_browser", "v3-browser-test-password");
    await page.getByRole("button", { name: "Dashboard", exact: true }).filter({ visible: true }).click();
    await expect(page.getByRole("heading", { name: "My dashboard", level: 2 })).toBeVisible();
    await expect(card(page, "nowenlab.hello-app/hello")).toBeVisible();
    await expect(card(page, "nowen-builtin/quick-note")).toBeVisible();

    // Quick note uses the regular note API; the new note shows up in Recent notes and on the server.
    await card(page, "nowen-builtin/quick-note").getByRole("textbox").fill("Workbench idea\nCaptured from the dashboard");
    await card(page, "nowen-builtin/quick-note").getByRole("button", { name: "Save as note", exact: true }).click();
    await expect(card(page, "nowen-builtin/quick-note")).toContainText("Saved to");
    await expect(card(page, "nowen-builtin/recent-notes")).toContainText("Workbench idea");
    const recent = await (await page.request.get(`${url}/api/notes?sortBy=recent&limit=5`, { headers })).json() as Array<{ title: string; contentFormat: string }>;
    expect(recent.find(note => note.title === "Workbench idea")?.contentFormat).toBe("markdown");

    // Today's tasks writes through the task-center toggle.
    const taskRow = card(page, "nowen-builtin/today-tasks").getByRole("checkbox", { name: "Workbench acceptance task" });
    await taskRow.check();
    await expect.poll(async () => (await (await page.request.get(`${url}/api/tasks/${task.id}`, { headers })).json()).isCompleted).toBe(1);

    // Edit layout: resize, hide, keyboard reorder, undo and rename; everything survives a reload.
    await page.getByRole("button", { name: "Edit layout", exact: true }).click();
    await card(page, "nowen-builtin/recent-notes").getByLabel("Card size", { exact: true }).selectOption("large");
    await card(page, "nowen-builtin/favorites").getByRole("button", { name: "Hide card", exact: true }).click();
    await card(page, "nowen-builtin/diary-calendar").getByRole("button", { name: "Remove card", exact: true }).click();
    await expect(card(page, "nowen-builtin/diary-calendar")).toHaveCount(0);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(card(page, "nowen-builtin/diary-calendar")).toBeVisible();
    const ids = async () => page.locator("[data-widget-id]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-widget-id")));
    const before = await ids();
    const statsIndex = before.indexOf("nowen-builtin/task-stats");
    await card(page, "nowen-builtin/task-stats").getByRole("button", { name: /Drag or use the arrow keys/ }).focus();
    await page.keyboard.press("ArrowUp");
    expect((await ids()).indexOf("nowen-builtin/task-stats")).toBe(statsIndex - 1);
    await expect(card(page, "nowen-builtin/task-stats").getByRole("button", { name: /Drag or use the arrow keys/ })).toBeFocused();
    await page.getByRole("button", { name: "Rename layout", exact: true }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("Daily");
    await page.getByRole("dialog").getByRole("button", { name: "Save name", exact: true }).click();
    await page.getByRole("button", { name: "Finish editing", exact: true }).click();
    const order = await ids();
    await page.reload();
    await expect(page.getByLabel("Dashboard layout", { exact: true })).toHaveValue("Daily");
    await expect(card(page, "nowen-builtin/recent-notes")).toHaveClass(/col-span-3/);
    await expect(card(page, "nowen-builtin/favorites")).toHaveCount(0);
    expect(await ids()).toEqual(order.filter(id => id !== "nowen-builtin/favorites"));

    // Disabling the plugin leaves a dormant placeholder in place; enabling restores the live card.
    expect((await page.request.post(`${url}/api/plugins/nowenlab.hello-app/disable`, { headers })).ok()).toBe(true);
    await expect(card(page, "nowenlab.hello-app/hello")).toHaveCount(0);
    const dormant = page.locator('[data-dormant-widget-id="nowenlab.hello-app/hello"]');
    await expect(dormant).toContainText("Card unavailable");
    await expect(dormant.getByRole("button", { name: "Go to My plugins", exact: true })).toBeVisible();
    expect((await page.request.post(`${url}/api/plugins/nowenlab.hello-app/enable`, { headers })).ok()).toBe(true);
    await expect(card(page, "nowenlab.hello-app/hello")).toBeVisible();
    await expect(dormant).toHaveCount(0);

    await page.evaluate(() => localStorage.setItem("nowen-note-theme", "dark"));
    await page.reload();
    await expect(card(page, "nowen-builtin/quick-note")).toBeVisible();
    await expect(page.getByText("No tags", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("workbench-dark.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(card(page, "nowen-builtin/quick-note")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Narrow screens keep their own layout, so the desktop rename does not apply here.
    await expect(page.getByLabel("Dashboard layout", { exact: true })).toHaveValue("Default");
    await page.screenshot({ path: test.info().outputPath("workbench-narrow.png") });
    await page.evaluate(() => localStorage.setItem("nowen-note-theme", "light"));
    await page.setViewportSize({ width: 1440, height: 960 });

    // Another account on the same browser sees its own default layout and none of the admin's notes.
    const memberContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const member = await memberContext.newPage();
    try {
      await signIn(member, "v3_member", "v3-member-test-password");
      await member.getByRole("button", { name: "Dashboard", exact: true }).filter({ visible: true }).click();
      await expect(card(member, "nowen-builtin/recent-notes")).toBeVisible();
      await expect(member.getByLabel("Dashboard layout", { exact: true })).toHaveValue("Default");
      await expect(card(member, "nowen-builtin/recent-notes")).not.toContainText("Workbench idea");
      await expect(card(member, "nowen-builtin/today-tasks")).not.toContainText("Workbench acceptance task");
    } finally { await memberContext.close(); }
  } finally {
    if (server.exitCode === null) { const exited = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
    await test.info().attach("disposable-backend-log", { body: logs.slice(-8000), contentType: "text/plain" });
  }
});
