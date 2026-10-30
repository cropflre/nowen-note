import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type TextResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "../dist/scoped-entry.js");

test("task tools preserve wall times, label UTC metadata and create scoped reminders", async () => {
  const writes: Array<{ path: string; body: any }> = [];
  const backend = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("Content-Type", "application/json");
    const reply = (value: unknown) => res.end(JSON.stringify(value));
    if (req.method !== "GET") writes.push({ path: url.pathname, body });
    if (url.pathname === "/api/notes/n-871") return reply({
      id: "n-871", notebookId: "root", title: "Time", contentFormat: "markdown",
      contentText: "2026-10-20 01:30:00", createdAt: "2026-10-20 01:30:00", updatedAt: "2026-10-20T09:30:00+08:00",
    });
    if (url.pathname === "/api/task-reminders/task-1") return reply([{ id: "reminder-1", ...body }]);
    if (url.pathname.startsWith("/api/tasks")) return reply({
      id: "task-1", workspaceId: url.pathname.endsWith("team") ? "ws-1" : null,
      createdAt: "2026-10-20 01:30:00", updatedAt: "2026-10-20 01:30:00",
      dueDate: "2026-10-21", dueAt: "2026-10-21T09:30", ...body,
    });
    res.statusCode = 404;
    reply({ error: "unsupported" });
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const address = backend.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (const mode of ["read-write", "read-only"]) {
      const client = new Client({ name: "issue-871", version: "1" }, { capabilities: {} });
      const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: {
        ...process.env, NOWEN_URL: `http://127.0.0.1:${address.port}`,
        NOWEN_API_TOKEN: "nkn_test", ALLOWED_NOTEBOOK_IDS: "root", MCP_ACCESS_MODE: mode,
      } as Record<string, string> });
      try {
        await client.connect(transport);
        const names = (await client.listTools()).tools.map(tool => tool.name);
        assert.ok(names.includes("nowen_create_task_reminder"));
        assert.ok(names.includes("nowen_list_task_reminders"));
        const read = await client.callTool({ name: "nowen_get_task", arguments: { taskId: "task-1" } });
        const task = JSON.parse(resultText(read));
        assert.equal(task.createdAt, "2026-10-20T01:30:00Z");
        assert.equal(task.dueAt, "2026-10-21T09:30");
        assert.equal(new Date(task.createdAt).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }), "2026-10-20 09:30:00");
        const noteResult = await client.callTool({ name: "nowen_read_note", arguments: { noteId: "n-871" } });
        assert.ok(!noteResult.isError, resultText(noteResult));
        const note = JSON.parse(resultText(noteResult));
        assert.equal(note.createdAt, "2026-10-20T01:30:00Z");
        assert.equal(note.updatedAt, "2026-10-20T09:30:00+08:00");
        assert.equal(note.contentText, "2026-10-20 01:30:00");
        const count = writes.length;
        for (const name of ["nowen_create_task", "nowen_create_subtask", "nowen_update_task"]) {
          const result = await client.callTool({ name, arguments: {
            title: "Meeting", taskId: "task-1", parentTaskId: "task-1",
            dueDate: "2026-10-21", dueAt: "2026-10-21T09:30",
          } });
          if (mode === "read-only") assert.equal(result.isError, true);
          else {
            assert.ok(!result.isError, resultText(result));
            assert.equal(writes.at(-1)?.body.dueAt, "2026-10-21T09:30");
          }
        }
        const reminderArgs = { taskId: "task-1", offsetMinutes: 30, timezoneOffsetMinutes: -480 };
        const created = await client.callTool({ name: "nowen_create_task_reminder", arguments: reminderArgs });
        if (mode === "read-only") {
          assert.equal(created.isError, true);
          assert.equal(writes.length, count);
        } else {
          assert.ok(!created.isError, resultText(created));
          assert.deepEqual(writes.at(-1), { path: "/api/task-reminders/task-1", body: {
            offsetMinutes: 30, timezoneOffsetMinutes: -480,
          } });
        }
        const listed = await client.callTool({ name: "nowen_list_task_reminders", arguments: { taskId: "task-1" } });
        assert.ok(!listed.isError, resultText(listed));
        const team = await client.callTool({ name: "nowen_create_task_reminder", arguments: { ...reminderArgs, taskId: "team" } });
        assert.equal(team.isError, true);
        const invalid = await client.callTool({ name: "nowen_create_task_reminder", arguments: { ...reminderArgs, timezoneOffsetMinutes: 9999 } });
        assert.equal(invalid.isError, true);
      } finally { await client.close(); }
    }
  } finally { await new Promise<void>(resolve => backend.close(() => resolve())); }
});

function resultText(value: TextResult): string {
  return value.content?.map((item) => item.text || "").join("\n") || "";
}

test("real stdio MCP client previews changes, enforces confirmation and blocks permanent deletion", async () => {
  const writes: Array<{ method: string; path: string; body: any }> = [];
  const note = {
    id: "n-1", title: "Example", notebookId: "root", isTrashed: 0,
    version: 7, content: "Hello", contentText: "Hello", contentFormat: "markdown",
  };
  const nodes = [
    { id: "notebook:root", parentId: null, resourceType: "notebook", resourceId: "root",
      title: "Root", updatedAt: "2026-10-16T09:00:00Z", isDeleted: 0, childCount: 1, workspaceId: null },
    { id: "note:n-1", parentId: "notebook:root", resourceType: "note", resourceId: "n-1",
      title: "Example", updatedAt: "2026-10-16T09:00:00Z", isDeleted: 0, childCount: 0, workspaceId: null },
    { id: "notebook:private", parentId: null, resourceType: "notebook", resourceId: "private",
      title: "Private", updatedAt: "2026-10-16T09:00:00Z", isDeleted: 0, childCount: 1, workspaceId: null },
    { id: "note:private", parentId: "notebook:private", resourceType: "note", resourceId: "private",
      title: "Private document", updatedAt: "2026-10-16T09:00:00Z", isDeleted: 0, childCount: 0, workspaceId: null },
  ];
  const backend: Server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf8");
    let body: any = {};
    try { if (bodyText) body = JSON.parse(bodyText); } catch {}
    res.setHeader("Content-Type", "application/json");
    const reply = (status: number, data: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== "Bearer nkn_integration_test") {
      reply(401, { code: "UNAUTHENTICATED", error: "missing PAT" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      writes.push({ method: req.method || "", path: pathname, body });
    }
    if (pathname === "/api/notebooks") {
      reply(200, [{ id: "root", parentId: null, name: "Root" }, { id: "private", parentId: null, name: "Private" }]);
    } else if (pathname === "/api/notebooks/shared-with-me") {
      reply(200, []);
    } else if (pathname === "/api/knowledge-tree/") {
      reply(200, { nodes, passwordAuthorizedNotes: [] });
    } else if (pathname === "/api/notes/n-1" && req.method === "GET") {
      reply(200, note);
    } else if (pathname === "/api/knowledge-tree/nodes/note:n-1" && req.method === "PATCH") {
      reply(200, { success: true, id: "note:n-1", title: body.title });
    } else {
      reply(404, { code: "NOT_FOUND", path: pathname });
    }
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const address = backend.address();
  assert.ok(address && typeof address !== "string");
  const backendUrl = `http://127.0.0.1:${address.port}`;

  const connect = async (accessMode: "read-only" | "read-write") => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        ...process.env,
        NOWEN_URL: backendUrl,
        NOWEN_API_TOKEN: "nkn_integration_test",
        ALLOWED_NOTEBOOK_IDS: "root",
        MCP_INCLUDE_DESCENDANTS: "true",
        MCP_ACCESS_MODE: accessMode,
      } as Record<string, string>,
    });
    const client = new Client({ name: "nowen-test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    return client;
  };

  let writer: Client | null = null;
  let reader: Client | null = null;
  try {
    writer = await connect("read-write");
    const tools = await writer.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "nowen_preview_knowledge_tree_change"));
    assert.ok(tools.tools.some((tool) => tool.name === "nowen_apply_knowledge_tree_change"));

    const pluginBlocked = await writer.callTool({
      name: "nowen_execute_plugin_action",
      arguments: { pluginId: "test", actionId: "unsafe", input: {} },
    }) as TextResult;
    assert.equal(pluginBlocked.isError, true);
    assert.match(resultText(pluginBlocked), /默认关闭/);

    const denyPermanent = await writer.callTool({
      name: "nowen_delete_note",
      arguments: { noteId: "n-1", permanent: true },
    }) as TextResult;
    assert.equal(denyPermanent.isError, true);
    assert.match(resultText(denyPermanent), /永久删除已禁用/);

    const preview = await writer.callTool({
      name: "nowen_preview_knowledge_tree_change",
      arguments: { operation: "rename", nodeId: "note:n-1", title: "Renamed" },
    }) as TextResult;
    assert.ok(!preview.isError, resultText(preview));
    const plan = JSON.parse(resultText(preview));
    assert.equal(plan.dryRun, true);
    assert.match(plan.revision, /^[0-9a-f]{64}$/);

    const unauthorized = await writer.callTool({
      name: "nowen_preview_knowledge_tree_change",
      arguments: { operation: "rename", nodeId: "note:private", title: "Stolen" },
    }) as TextResult;
    assert.equal(unauthorized.isError, true);

    const deniedApply = await writer.callTool({
      name: "nowen_apply_knowledge_tree_change",
      arguments: {
        operation: "rename", nodeId: "note:n-1", title: "Renamed",
        expectedRevision: plan.revision, confirmation: "MOVE_TREE_TO_TRASH",
      },
    }) as TextResult;
    assert.equal(deniedApply.isError, true);
    assert.equal(writes.length, 0);

    const applied = await writer.callTool({
      name: "nowen_apply_knowledge_tree_change",
      arguments: {
        operation: "rename", nodeId: "note:n-1", title: "Renamed",
        expectedRevision: plan.revision, confirmation: "APPLY_TREE_CHANGE",
      },
    }) as TextResult;
    assert.ok(!applied.isError, resultText(applied));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, "/api/knowledge-tree/nodes/note:n-1");
    assert.equal(writes[0].body.expectedUpdatedAt, nodes[1].updatedAt);

    reader = await connect("read-only");
    const blockedCreate = await reader.callTool({
      name: "nowen_create_note",
      arguments: { notebookId: "root", title: "Should not be written", content: "test" },
    }) as TextResult;
    assert.equal(blockedCreate.isError, true);
    assert.match(resultText(blockedCreate), /read-only/);
    assert.equal(writes.length, 1);
  } finally {
    await writer?.close();
    await reader?.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  }
});
