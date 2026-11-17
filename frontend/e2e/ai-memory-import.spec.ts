import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";

// One import entry: a ChatGPT export dropped into "Import notes" is recognized and imported into the AI
// conversation archive instead of becoming one huge note.
test("a ChatGPT export dropped into Import notes goes to the AI conversation archive", async ({ page }) => {
  const root = path.resolve(".."), directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-v3-browser-"));
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-chat-export-"));
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
    // A synthetic ChatGPT export: conversations.json plus the chat.html viewer and user.json that real exports include.
    const message = (id: string, role: string, text: string) => ({ id, author: { role }, content: { content_type: "text", parts: [text] }, status: "finished_successfully" });
    const conversation = { id: "conv-1", title: "Weekend in Hangzhou", current_node: "n3", mapping: {
      n1: { id: "n1", parent: null, children: ["n2"], message: null },
      n2: { id: "n2", parent: "n1", children: ["n3"], message: message("m-user", "user", "Plan a weekend in Hangzhou.") },
      n3: { id: "n3", parent: "n2", children: [], message: message("m-assistant", "assistant", "Day 1: West Lake. Day 2: Lingyin Temple.") },
    } };
    const zip = new JSZip();
    zip.file("conversations.json", JSON.stringify([conversation])); zip.file("chat.html", "<html><body>viewer</body></html>"); zip.file("user.json", "{}");
    const exported = path.join(fixtures, "chatgpt-export.zip");
    fs.writeFileSync(exported, await zip.generateAsync({ type: "nodebuffer" }));

    await expect.poll(() => fetch(`${url}/api/health`).then(response => response.ok).catch(() => false), { timeout: 30000, message: "Disposable backend starts" }).toBe(true);
    const session = (await (await page.request.post(`${url}/api/auth/login`, { data: { username: "v3_browser", password: "v3-browser-test-password" } })).json()).token as string;
    const headers = { Authorization: `Bearer ${session}` };
    expect((await page.request.post(`${url}/api/onboarding/welcome`, { headers })).ok()).toBe(true);
    expect((await page.request.put(`${url}/api/settings`, { headers, data: { feature_ai_memory_enabled: true } })).ok()).toBe(true);

    await page.goto(url);
    await page.evaluate(version => { localStorage.setItem("i18nextLng", "en"); localStorage.setItem("nowen-seen-version", version); }, uiVersion);
    await page.reload();
    await page.getByPlaceholder("admin", { exact: true }).fill("v3_browser");
    await page.locator("input[type=password]").fill("v3-browser-test-password");
    await page.locator("button[type=submit]").click();
    await page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "Data", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "Import notes", exact: true }).click();
    // The data page no longer carries a separate AI import button: "Import notes" is the one entry.
    await expect(page.getByRole("button", { name: /Import AI/ })).toHaveCount(0);

    await page.getByLabel("Choose note files to import", { exact: true }).setInputFiles(exported);
    const choice = page.getByRole("region", { name: "This is an AI chat export" });
    await expect(choice).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("chat-export-recognized.png") });
    await choice.getByRole("button", { name: "Import into the AI conversation archive", exact: true }).click();

    const archive = page.getByRole("dialog", { name: "AI conversation archive", exact: true });
    await expect(archive).toContainText("Ready to import “chatgpt-export.zip”");
    await archive.getByText("Create a source", { exact: true }).click();
    await expect(archive.getByLabel("Source type")).toHaveValue("chatgpt");
    await archive.getByLabel("I authorize saving conversations from the selected files to this notebook").check();
    await archive.getByRole("button", { name: "Create source", exact: true }).click();
    // The preview starts on its own once the source exists; nothing is imported before confirming.
    const job = archive.getByRole("region", { name: "chatgpt-export.zip" });
    await expect(job).toContainText("Weekend in Hangzhou");
    await job.getByRole("checkbox", { name: "I reviewed the conversations, completeness warnings and destination source" }).check();
    await job.getByRole("button", { name: "Confirm import", exact: true }).click();
    await expect(job).toContainText("Completed", { timeout: 30000 });
    await archive.getByRole("button", { name: "Conversations", exact: true }).click();
    await expect(archive).toContainText("Weekend in Hangzhou");
    await expect(archive).toContainText("2 messages");
    await page.screenshot({ path: test.info().outputPath("chat-export-archived.png") });

    // Nothing went through the notes import, and the conversation landed in the "AI conversations" notebook.
    expect((await (await page.request.get(`${url}/api/migrations`, { headers })).json()).items ?? []).toHaveLength(0);
    const notebooks = await (await page.request.get(`${url}/api/notebooks?workspaceId=personal`, { headers })).json() as Array<{ name: string }>;
    expect(notebooks.map(item => item.name)).toContain("AI conversations");
  } finally {
    if (server.exitCode === null) { const exited = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(fixtures, { recursive: true, force: true });
    await test.info().attach("disposable-backend-log", { body: logs.slice(-8000), contentType: "text/plain" });
  }
});
