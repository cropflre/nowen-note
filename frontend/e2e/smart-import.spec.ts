import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYZkAAAAASUVORK5CYII=", "base64");

async function zipFolder(folder: string, file: string, skip: string[] = []) {
  const zip = new JSZip();
  const add = (directory: string, prefix: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) add(full, `${prefix}${entry.name}/`); else zip.file(`${prefix}${entry.name}`, fs.readFileSync(full));
    }
  };
  add(folder, "");
  for (const name of skip) zip.remove(name);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
}

// "Import notes" through production routes and the real migration pipeline: a Notion export ZIP, a repeated
// import, an Obsidian folder with ![[embeds]] and [[links]], a damaged file, and both languages.
test("imports exports in three steps, keeps Obsidian images and links, never duplicates, and explains broken files", async ({ page }) => {
  const root = path.resolve(".."), directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-v3-browser-"));
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-import-fixtures-"));
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
    // Fixtures: the repository's Notion export, an Obsidian vault folder, and a file that only looks like a ZIP.
    const notion = path.join(fixtures, "Notion Export.zip");
    await zipFolder(path.join(root, "backend/tests/fixtures/migration-notion"), notion, ["README.md"]);
    const vault = path.join(fixtures, "Vault");
    fs.mkdirSync(path.join(vault, "Daily"), { recursive: true }); fs.mkdirSync(path.join(vault, "attachments")); fs.mkdirSync(path.join(vault, "Projects")); fs.mkdirSync(path.join(vault, ".obsidian"));
    fs.writeFileSync(path.join(vault, "Daily/2024-01-01.md"), "---\ntitle: New year\ntags: [daily]\n---\nA photo: ![[Pasted image.png]]\nNext: [[Plan]]\n");
    fs.writeFileSync(path.join(vault, "attachments/Pasted image.png"), png);
    fs.writeFileSync(path.join(vault, "Projects/Plan.md"), "# Plan\nShip it.\n");
    fs.writeFileSync(path.join(vault, ".obsidian/workspace.json"), "{}");
    const broken = path.join(fixtures, "broken.zip");
    fs.writeFileSync(broken, "this is not a zip archive");

    await expect.poll(() => fetch(`${url}/api/health`).then(response => response.ok).catch(() => false), { timeout: 30000, message: "Disposable backend starts" }).toBe(true);
    const token = (await (await page.request.post(`${url}/api/auth/login`, { data: { username: "v3_browser", password: "v3-browser-test-password" } })).json()).token as string;
    const headers = { Authorization: `Bearer ${token}` };
    expect((await page.request.post(`${url}/api/onboarding/welcome`, { headers })).ok()).toBe(true);
    await page.goto(url);
    await page.evaluate(version => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", version); }, uiVersion);
    await page.reload();
    await page.getByPlaceholder("admin", { exact: true }).fill("v3_browser");
    await page.locator("input[type=password]").fill("v3-browser-test-password");
    await page.locator("button[type=submit]").click();
    await expect(page.getByPlaceholder("admin", { exact: true })).not.toBeVisible({ timeout: 30000 });

    const openImport = async (target: Page = page) => {
      await target.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true }).click();
      await target.getByRole("button", { name: "Data", exact: true }).filter({ visible: true }).click();
      await target.getByRole("button", { name: "Import notes", exact: true }).click();
      await expect(target.getByRole("heading", { name: "Import notes", exact: true })).toBeVisible();
    };
    const result = page.getByRole("region", { name: "Import progress and result" });

    // Scenario A — one drop area; the ZIP is recognized, summarized and imported after one click.
    await openImport();
    await expect(page.locator("[data-import-drop-zone]")).toContainText("Drop note files here, or click to choose");
    // No AI client picker or other setting inside the import card by default.
    await expect(page.getByRole("region", { name: "Import notes", exact: true }).getByRole("combobox")).toHaveCount(0);
    await page.getByLabel("Choose note files to import", { exact: true }).setInputFiles(notion);
    await expect(result.getByRole("heading", { name: "Found 2 notes", exact: true })).toBeVisible({ timeout: 60000 });
    await expect(result).toContainText("new folder “Notion Export”");
    // The fixture links to a page that was not exported and to a web page: both are said plainly, not as codes.
    await expect(result).toContainText("Some images, attachments or links are not in the files. Their original links are kept.");
    await expect(result).toContainText("Web images and links keep their original addresses and are not downloaded into Nowen.");
    await expect(result).not.toContainText("NOTION_");
    expect(await page.locator("body").innerText()).not.toContain("migration.");
    await page.screenshot({ path: test.info().outputPath("import-preview.png") });
    await result.getByRole("button", { name: "Import 2 notes", exact: true }).click();
    await expect(result.getByRole("heading", { name: "Your notes have been imported" })).toBeVisible({ timeout: 60000 });
    await page.screenshot({ path: test.info().outputPath("import-done.png") });
    await result.getByRole("button", { name: "View my notes", exact: true }).click();
    await expect(page.getByText("Alpha", { exact: true }).first()).toBeVisible();

    // Scenario E — the same export again: recognized as already imported, nothing is created twice.
    await openImport();
    await page.getByLabel("Choose note files to import", { exact: true }).setInputFiles(notion);
    await expect(result).toContainText("2 of them were imported before", { timeout: 60000 });
    await expect(result).toContainText("All of these notes were imported before. There is nothing new to import.");
    await expect(result.getByRole("button", { name: /^Import \d+ notes$/ })).toHaveCount(0);
    await result.getByRole("button", { name: "Cancel this import", exact: true }).click();
    await expect(result.getByRole("heading", { name: "This import was cancelled" })).toBeVisible();
    await result.getByRole("button", { name: "Choose other files", exact: true }).click();

    // Scenario B — an Obsidian folder: the embedded image becomes an attachment and [[Plan]] an internal link.
    await page.getByLabel("Choose a whole folder", { exact: true }).setInputFiles(vault);
    await expect(result.getByRole("heading", { name: "Found 2 notes and 1 image or attachment", exact: true })).toBeVisible({ timeout: 60000 });
    await expect(result).toContainText("new folder “Vault”");
    await result.getByRole("button", { name: "Import 2 notes", exact: true }).click();
    await expect(result.getByRole("heading", { name: "Your notes have been imported" })).toBeVisible({ timeout: 60000 });
    const notes = await (await page.request.get(`${url}/api/notes`, { headers })).json() as Array<{ id: string; title: string }>;
    const daily = notes.find(note => note.title === "New year"), plan = notes.find(note => note.title === "Plan");
    expect(daily && plan).toBeTruthy();
    const body = String((await (await page.request.get(`${url}/api/notes/${daily!.id}`, { headers })).json()).content);
    expect(body).toMatch(/!\[Pasted image\.png\]\(<?\/api\/attachments\/[0-9a-f-]{36}>?\)/);
    expect(body).toContain(`note:${plan!.id}`);
    expect(body).not.toContain("![[");

    // Scenario F — a damaged file reads as a plain explanation with a way forward.
    await result.getByRole("button", { name: "Import more notes", exact: true }).click();
    await page.getByLabel("Choose note files to import", { exact: true }).setInputFiles(broken);
    await expect(result.getByRole("alert")).toHaveText("The file seems damaged, or it is not a note format that can be recognized.", { timeout: 60000 });
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(result).not.toContainText("MIGRATION_");
    await expect(result.getByRole("button", { name: "Choose other files", exact: true })).toBeVisible();

    // The AI path is one click away and claims nothing it cannot know.
    await result.getByRole("button", { name: "Let AI move it for me", exact: true }).click();
    const assistant = page.getByRole("region", { name: "Let AI move it for me" });
    await expect(assistant).toContainText("Use the AI assistant you already have");
    await expect(assistant).not.toContainText("AI assistant connected");

    // Narrow screens: every control and line in the import card stays inside the window, with nothing clipped.
    const clipped = () => page.locator('section[aria-label="Import notes"]').evaluate(section => Array.from(section.querySelectorAll<HTMLElement>("button, p, h4, h5, li"))
      .filter(element => element.offsetParent !== null && (element.getBoundingClientRect().right > innerWidth + 0.5 || element.scrollWidth > element.clientWidth + 1))
      .map(element => element.textContent?.trim().slice(0, 60)));
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await clipped()).toEqual([]);
    await assistant.getByRole("button", { name: "Import files directly instead", exact: true }).click();
    await expect(page.locator("[data-import-drop-zone]")).toBeVisible();
    expect(await clipped()).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("import-narrow.png") });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(() => localStorage.setItem("i18nextLng", "zh-CN"));
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "数据管理", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "导入笔记", exact: true }).click();
    await expect(page.getByRole("heading", { name: "导入笔记", exact: true })).toBeVisible();
    await expect(page.locator("[data-import-drop-zone]")).toContainText("拖入笔记文件，或点击选择");
    await expect(page.getByRole("button", { name: "没有导出文件？让 AI 帮我搬家" })).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain("migration.");
  } finally {
    if (server.exitCode === null) { const exited = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(fixtures, { recursive: true, force: true });
    await test.info().attach("disposable-backend-log", { body: logs.slice(-8000), contentType: "text/plain" });
  }
});
