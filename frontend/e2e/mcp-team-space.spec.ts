import { test, expect, type APIRequestContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

type ToolResult = { isError?: boolean; content?: Array<{ text?: string }> };
type StdioReply = { id: number; result: ToolResult & { serverInfo?: { name: string } } };
const text = (result: ToolResult) => (result.content || []).map(item => item.text || "").join("\n");

/** Talks newline-delimited JSON-RPC to the standalone stdio MCP launcher, as a desktop AI client would. */
async function stdioTool(launcher: string, baseUrl: string, token: string, calls: Array<[string, Record<string, unknown>]>): Promise<ToolResult[]> {
  const child = spawn(process.execPath, [launcher], { env: { ...process.env, NOWEN_URL: baseUrl, NOWEN_API_TOKEN: token }, stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map<number, (value: StdioReply) => void>();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) { const message = JSON.parse(line) as StdioReply; replies.get(message.id)?.(message); }
    }
  });
  let id = 0;
  const request = (method: string, params: unknown) => new Promise<StdioReply>((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => reject(new Error(`stdio MCP timed out: ${method}`)), 20000);
    replies.set(current, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params })}\n`);
  });
  try {
    expect((await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "team-space-e2e", version: "1" } })).result.serverInfo?.name).toBe("nowen-note");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const results: ToolResult[] = [];
    for (const [name, args] of calls) results.push((await request("tools/call", { name, arguments: args })).result);
    return results;
  } finally {
    child.kill();
    if (child.exitCode === null) await once(child, "exit");
  }
}

// Acceptance: a team member selects one team notebook in Settings → Connect AI assistant, the panel verifies the
// real embedded MCP, and an AI can then read and edit only that notebook until the member is downgraded or removed.
test("a member authorizes one team notebook and an AI reads and edits only it through the real MCP", async ({ page }) => {
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
  const json = async (request: APIRequestContext, method: "get" | "post" | "put" | "delete", pathname: string, bearer: string, data?: unknown) => {
    const response = await request[method](`${url}${pathname}`, { headers: { Authorization: `Bearer ${bearer}` }, ...(data === undefined ? {} : { data }) });
    expect(response.ok(), `${method.toUpperCase()} ${pathname}: ${await response.text()}`).toBe(true);
    return response.json();
  };
  try {
    await expect.poll(() => fetch(`${url}/api/health`).then(response => response.ok).catch(() => false), { timeout: 30000, message: "Disposable backend starts" }).toBe(true);
    const login = async (username: string, password: string) => (await (await page.request.post(`${url}/api/auth/login`, { data: { username, password } })).json()).token as string;
    const admin = await login("v3_browser", "v3-browser-test-password");
    await json(page.request, "post", "/api/onboarding/welcome", admin);
    await json(page.request, "put", "/api/mcp", admin, { enabled: true, allowWrite: true, publicUrl: `${url}/mcp` });
    const member = await json(page.request, "post", "/api/users", admin, { username: "team_editor", password: "team-editor-password", role: "user" }) as { id: string };
    const workspace = await json(page.request, "post", "/api/workspaces", admin, { name: "产品研发团队" }) as { id: string };
    const invite = await json(page.request, "post", `/api/workspaces/${workspace.id}/invites`, admin, { role: "editor" }) as { code: string };
    const memberSession = await login("team_editor", "team-editor-password");
    await json(page.request, "post", "/api/workspaces/join", memberSession, { code: invite.code });
    await json(page.request, "post", "/api/onboarding/welcome", memberSession);
    const docs = await json(page.request, "post", "/api/notebooks", admin, { name: "项目文档", workspaceId: workspace.id }) as { id: string };
    const secret = await json(page.request, "post", "/api/notebooks", admin, { name: "保密资料", workspaceId: workspace.id }) as { id: string };
    const teamNote = await json(page.request, "post", "/api/notes", admin, { notebookId: docs.id, title: "需求说明", content: "团队需求 alphaword", contentFormat: "markdown" }) as { id: string };
    const secretNote = await json(page.request, "post", "/api/notes", admin, { notebookId: secret.id, title: "保密计划", content: "secretbody alphaword", contentFormat: "markdown" }) as { id: string };
    const personal = await json(page.request, "post", "/api/notebooks", memberSession, { name: "项目文档" }) as { id: string };

    // The member's normal UI flow: choose the assistant, select one team notebook and click Connect.
    await page.goto(url);
    await page.evaluate(version => { localStorage.setItem("i18nextLng", "zh-CN"); localStorage.setItem("nowen-seen-version", version); }, uiVersion);
    await page.reload();
    await page.getByPlaceholder("admin", { exact: true }).fill("team_editor");
    await page.locator("input[type=password]").fill("team-editor-password");
    await page.locator("button[type=submit]").click();
    await page.getByRole("button", { name: "设置", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "连接 AI 助手", exact: true }).filter({ visible: true }).click();
    const panel = page.getByRole("region", { name: "快速连接 AI 助手" });
    const personalGroup = panel.getByRole("group", { name: "个人空间" });
    const teamGroup = panel.getByRole("group", { name: "产品研发团队" });
    await expect(personalGroup.getByLabel("项目文档")).toBeChecked();
    await expect(panel.getByText("团队空间", { exact: true })).toBeVisible();
    await expect(teamGroup.getByLabel("项目文档")).toHaveCount(0);
    await teamGroup.getByRole("button", { name: "展开「产品研发团队」" }).click();
    await expect(teamGroup.getByLabel("项目文档")).not.toBeChecked();
    await expect(teamGroup).toContainText("可编辑");
    await teamGroup.getByLabel("项目文档").check();
    await expect(panel.getByText("AI 助手将可以访问你选中的团队笔记。请确认团队内容允许接入该助手。", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("team-notebook-selected.png") });
    const created = page.waitForResponse(response => response.url() === `${url}/api/tokens` && response.request().method() === "POST");
    await panel.getByRole("button", { name: "连接", exact: true }).click();
    const grant = await (await created).json() as { id: string; token: string; notebookResources: Array<{ notebookId: string; permission: string }> };
    // Personal notebooks (including the generated welcome guide) are preselected; in the team only the chosen one.
    const granted = grant.notebookResources.map(item => item.notebookId);
    expect(granted).toEqual(expect.arrayContaining([docs.id, personal.id]));
    expect(granted).not.toContain(secret.id);
    await expect(panel.getByText("准备好了", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("connection-ready.png") });

    // The AI side: the exact credential the panel created, against the real embedded MCP endpoint.
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await page.request.post(`${url}/mcp`, { headers: { Authorization: `Bearer ${grant.token}`, Accept: "application/json, text/event-stream" },
        data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
      expect(response.status(), await response.text()).toBe(200);
      return (await response.json()).result as ToolResult;
    };
    const catalog = JSON.parse(text(await tool("nowen_list_notebooks"))) as Array<Record<string, unknown>>;
    expect(catalog.find(item => item.notebookId === docs.id)).toMatchObject({ workspaceId: workspace.id, workspaceName: "产品研发团队", permission: "write" });
    expect(catalog.find(item => item.notebookId === personal.id)).toMatchObject({ workspaceId: "personal", notebookName: "项目文档" });
    expect(JSON.stringify(catalog)).not.toContain("保密资料");
    expect(text(await tool("nowen_read_note", { noteId: teamNote.id }))).toContain("团队需求 alphaword");
    expect((await tool("nowen_read_note", { noteId: secretNote.id })).isError).toBe(true);
    const found = text(await tool("nowen_search", { query: "alphaword" }));
    expect(found).toContain(teamNote.id);
    expect(found).not.toContain(secretNote.id);
    expect((await tool("nowen_update_note", { noteId: teamNote.id, content: "团队需求 alphaword，AI 已补充验收标准" })).isError ?? false).toBe(false);
    expect((await tool("nowen_create_note", { notebookId: docs.id, title: "AI 会议纪要", content: "由 AI 助手创建" })).isError ?? false).toBe(false);
    const teamNotes = await json(page.request, "get", `/api/notes?notebookId=${docs.id}`, admin) as Array<{ title: string }>;
    expect(teamNotes.map(note => note.title)).toContain("AI 会议纪要");
    expect((await json(page.request, "get", `/api/notes/${teamNote.id}`, admin) as { content: string }).content).toContain("AI 已补充验收标准");

    // The same credential in the standalone npm/stdio MCP, through the production REST stack.
    const launcher = path.join(root, "packages/nowen-mcp/bin/nowen-mcp.mjs");
    const [stdioRead, stdioSecret] = await stdioTool(launcher, url, grant.token, [["nowen_read_note", { noteId: teamNote.id }], ["nowen_read_note", { noteId: secretNote.id }]]);
    expect(text(stdioRead)).toContain("AI 已补充验收标准");
    expect(stdioSecret.isError).toBe(true);

    // Team administrators withdraw access by changing membership; the token follows on the next call.
    await json(page.request, "put", `/api/workspaces/${workspace.id}/members/${member.id}`, admin, { role: "viewer" });
    expect(text(await tool("nowen_read_note", { noteId: teamNote.id }))).toContain("AI 已补充验收标准");
    expect((await tool("nowen_update_note", { noteId: teamNote.id, content: "viewer edit" })).isError).toBe(true);
    await json(page.request, "delete", `/api/workspaces/${workspace.id}/members/${member.id}`, admin);
    expect((await tool("nowen_read_note", { noteId: teamNote.id })).isError).toBe(true);
    expect(text(await tool("nowen_list_notebooks"))).not.toContain(workspace.id);
    expect((await json(page.request, "get", `/api/notes/${teamNote.id}`, admin) as { content: string }).content).not.toContain("viewer edit");
  } finally {
    if (server.exitCode === null) { const exited = new Promise<void>(resolve => server.once("exit", () => resolve())); server.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
    await test.info().attach("disposable-backend-log", { body: logs.slice(-8000), contentType: "text/plain" });
  }
});
