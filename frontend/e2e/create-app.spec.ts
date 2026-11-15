import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

// Create-app acceptance through production routes: the Extension Center entry, the template library, the
// AI draft flow (only the model is a deterministic stand-in), real saving and loading, and the dashboard card.
test("creates apps from AI and from templates, saves them and adds them to the dashboard", async ({ page }) => {
  test.setTimeout(180_000);
  const root = path.resolve(".."), directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-v3-browser-"));
  const executable = process.env.NOWEN_QA_NODE || process.execPath;
  const port = await new Promise<number>(resolve => { const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => { const value = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(value)); }); });
  const url = `http://127.0.0.1:${port}`;
  let logs = "";
  const server = spawn(executable, ["--import", pathToFileURL(path.join(root, "backend/node_modules/tsx/dist/loader.mjs")).href, path.join(root, "backend/tests/application-v3-browser-server.ts")], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", V3_BROWSER_PROFILE: directory, V3_BROWSER_AI_FIXTURE: "1", FRONTEND_DIST: path.join(root, "frontend/dist"), PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", chunk => { logs += chunk; }); server.stderr.on("data", chunk => { logs += chunk; });
  const uiVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  try {
    await expect.poll(() => fetch(`${url}/api/health`).then(response => response.ok).catch(() => false), { timeout: 30000, message: "Disposable backend starts" }).toBe(true);
    // The server opens the welcome guide once per account, on whichever page asks first. Claim it before the
    // first page load so it can never replace the page under test.
    const token = (await (await page.request.post(`${url}/api/auth/login`, { data: { username: "v3_browser", password: "v3-browser-test-password" } })).json()).token as string;
    expect((await page.request.post(`${url}/api/onboarding/welcome`, { headers: { Authorization: `Bearer ${token}` } })).ok()).toBe(true);
    await page.goto(url);
    await page.evaluate(version => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", version); }, uiVersion);
    await page.reload();
    await page.getByPlaceholder("admin", { exact: true }).fill("v3_browser");
    await page.locator("input[type=password]").fill("v3-browser-test-password");
    await page.locator("button[type=submit]").click();
    await expect(page.getByPlaceholder("admin", { exact: true })).not.toBeVisible({ timeout: 30000 });

    // The create entry is a section of the Extension Center with the official template library.
    await page.goto(`${url}/apps/studio`);
    // "Create" is the single action next to the three tabs, not a fourth tab.
    await expect(page.getByRole("navigation", { name: "Extension Center navigation" }).getByRole("button")).toHaveText(["Discover", "Mine", "Dashboard"]);
    await expect(page.getByRole("button", { name: "Create", exact: true })).toHaveAttribute("aria-current", "page");
    for (const title of ["Project progress", "Reading log", "Habit tracker", "Meeting notes", "Travel checklist", "Daily to-dos"]) {
      await expect(page.getByRole("button", { name: title, exact: true })).toBeVisible();
    }

    // AI path: a matching template is suggested, a cancelled request keeps the description, then a draft is saved.
    const prompt = page.getByRole("textbox", { name: "AI App Builder", exact: true });
    await prompt.fill("A project board with owner and done status");
    await expect(page.getByRole("note").filter({ hasText: "A template may already fit" }).getByRole("button", { name: "Project progress", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Generate preview", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText("Cancelled. Your description is kept.", { exact: true })).toBeVisible();
    await expect(prompt).toHaveValue("A project board with owner and done status");
    // The server runs one Studio AI request per user; retry once the cancelled model call has ended.
    const draft = page.getByRole("region", { name: "AI draft" });
    await expect(async () => {
      await page.getByRole("button", { name: "Generate preview", exact: true }).click();
      await expect(draft).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 30000 });
    await expect(draft).toContainText("Owner");
    await expect(draft).toContainText("No plugin permissions; no generated code runs");
    await draft.getByRole("button", { name: "Use this draft", exact: true }).click();
    await page.getByRole("button", { name: "Save app", exact: true }).click();
    await expect(page).toHaveURL(/\/apps\/personal\/[0-9a-f-]{36}$/);
    const boardUrl = page.url(), boardId = boardUrl.split("/").pop()!;
    await expect(page.getByRole("heading", { name: "Project board", exact: true })).toBeVisible();
    await page.getByLabel("Item", { exact: true }).fill("Write launch notes");
    await page.getByLabel("Owner", { exact: true }).fill("Alex");
    await page.getByRole("button", { name: "Add record", exact: true }).click();
    await expect(page.getByText("Write launch notes", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("Write launch notes", { exact: true })).toBeVisible();

    // A host-rendered dashboard card (never an iframe) that survives a reload and opens the app.
    await page.getByRole("button", { name: "Add to dashboard", exact: true }).click();
    await expect(page).toHaveURL(/\/apps\/dashboard$/);
    const boardCard = page.locator(`[data-widget-id="nowen-builtin/studio-${boardId}"]`);
    await expect(boardCard).toContainText("Project board");
    await expect(boardCard).toContainText("Write launch notes");
    await expect(boardCard.locator("iframe")).toHaveCount(0);
    await page.reload();
    await expect(boardCard).toContainText("Project board");
    await boardCard.getByRole("button", { name: "Open app", exact: true }).click();
    await expect(page).toHaveURL(boardUrl);

    // Template path: a localized draft that is only created on save and loads back after a reload.
    await page.goto(`${url}/apps/studio`);
    await page.getByRole("button", { name: "Reading log", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Field type", exact: true })).toHaveValue("text");
    await page.getByRole("button", { name: "Save app", exact: true }).click();
    await expect(page.getByRole("heading", { name: "My reading log", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit app", exact: true })).toBeVisible();
    await page.getByLabel("Title", { exact: true }).fill("Dune");
    await page.getByLabel("Author", { exact: true }).fill("Frank Herbert");
    await page.getByRole("button", { name: "Add record", exact: true }).click();
    await page.reload();
    await expect(page.getByText("Frank Herbert", { exact: true })).toBeVisible();

    // Deleting the board leaves a dormant card that shows nothing of the deleted app.
    await page.goto(boardUrl);
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Delete app", exact: true }).click();
    await expect(page).toHaveURL(/\/apps$/);
    await page.goto(`${url}/apps/dashboard`);
    const dormant = page.locator(`[data-dormant-widget-id="nowen-builtin/studio-${boardId}"]`);
    await expect(dormant).toContainText("This personal app was deleted or belongs to another account.");
    await expect(dormant).not.toContainText("Project board");
    await expect(dormant).not.toContainText("Write launch notes");

    await page.goto(`${url}/apps/studio`);
    await expect(page.getByRole("button", { name: "Reading log", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("create-app-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "Reading log", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("create-app-mobile.png"), fullPage: true });
  } finally {
    if (server.exitCode === null) { const exited = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
    await test.info().attach("disposable-backend-log", { body: logs.slice(-8000), contentType: "text/plain" });
  }
});
