import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-mcp-task-delete-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.ELECTRON_USER_DATA = dir;

const here = path.dirname(fileURLToPath(import.meta.url));
const stdioEntry = path.resolve(here, "../../packages/nowen-mcp/dist/scoped-entry.js");

type ToolResult = { content?: Array<{ text?: string }>; isError?: boolean };
const text = (result: ToolResult) => (result.content || []).map((item) => item.text || "").join("\n");
const json = (result: ToolResult) => JSON.parse(text(result));

/** Minimal newline-delimited JSON-RPC client for the standalone stdio MCP entry. */
async function startStdioMcp(baseUrl: string, token: string, env: Record<string, string>) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [stdioEntry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NOWEN_URL: baseUrl, NOWEN_API_TOKEN: token, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, (message: any) => void>();
  let buffer = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`stdio MCP timed out on ${method}`)), 20_000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const initialized = await request("initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "task-delete-test", version: "1" },
  });
  assert.equal(initialized.result?.serverInfo?.name, "nowen-note");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await request("tools/call", { name, arguments: args })).result as ToolResult,
    close: async () => {
      child.kill();
      if (child.exitCode === null) await once(child, "exit");
    },
  };
}

test("MCP personal task deletion", async (t) => {
  const { getDb, closeDb } = await import("../src/db/schema");
  const { initApiTokensTable, hashApiToken, resolveApiToken } = await import("../src/lib/api-tokens");
  const { initAuditTables } = await import("../src/services/audit");
  const { enforceApiTokenAccess } = await import("../src/middleware/api-token-resource-scope");
  const { createEmbeddedMcpRouter, createMcpSettingsRouter } = await import("../src/mcp");
  const { default: tasks } = await import("../src/routes/tasks");
  const { serve } = await import("@hono/node-server");
  const db = getDb();
  let server: ReturnType<typeof serve> | undefined;
  try {
    initApiTokensTable(db);
    initAuditTables();
    db.exec(`
      INSERT INTO users (id, username, passwordHash, role) VALUES
        ('del-owner','del-owner','hash','user'), ('del-other','del-other','hash','user'),
        ('del-admin','del-admin','hash','admin');
      INSERT INTO workspaces (id, name, ownerId) VALUES ('del-ws', 'Study group', 'del-owner');
      INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('del-ws','del-owner','owner');
    `);
    const writer = "nkn_task-delete-writer-token-0000000001";
    const reader = "nkn_task-delete-reader-token-0000000002";
    for (const [id, value, scopes, mode] of [
      ["del-token-writer", writer, ["tasks:read", "tasks:write"], "restricted"],
      ["del-token-reader", reader, ["tasks:read"], "unrestricted"],
    ] as const) {
      db.prepare(`INSERT INTO api_tokens (id,userId,name,tokenHash,scopes,resourceMode) VALUES (?,?,?,?,?,?)`)
        .run(id, "del-owner", id, hashApiToken(value), JSON.stringify(scopes), mode);
    }
    const sessions: Record<string, string> = {
      "session-owner": "del-owner", "session-other": "del-other", "session-admin": "del-admin",
    };

    const app = new Hono();
    app.route("/mcp", createEmbeddedMcpRouter((request) => app.fetch(request)));
    app.use("/api/*", async (c, next) => {
      for (const header of ["X-User-Id", "X-Auth-Mode", "X-Api-Token-Id", "X-Api-Scopes", "X-Api-Resource-Mode"]) {
        c.req.raw.headers.delete(header);
      }
      const bearer = (c.req.header("Authorization") || "").slice(7);
      if (sessions[bearer]) {
        c.req.raw.headers.set("X-User-Id", sessions[bearer]);
      } else {
        const resolved = resolveApiToken(db, bearer);
        if (!resolved) return c.json({ error: "Unauthorized" }, 401);
        c.req.raw.headers.set("X-User-Id", resolved.userId);
        c.req.raw.headers.set("X-Auth-Mode", "api-token");
        c.req.raw.headers.set("X-Api-Token-Id", resolved.tokenId);
        c.req.raw.headers.set("X-Api-Resource-Mode", resolved.resourceMode);
        c.req.raw.headers.set("X-Api-Scopes", resolved.scopes.join(","));
      }
      await next();
    });
    app.use("/api/*", enforceApiTokenAccess);
    app.route("/api/mcp", createMcpSettingsRouter());
    app.route("/api/tasks", tasks);

    const api = (bearer: string, url: string, init: { method?: string; body?: unknown } = {}) =>
      app.request(`http://localhost${url}`, {
        method: init.method || "GET",
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    const create = async (bearer: string, body: Record<string, unknown>, workspaceId = "personal") => {
      const response = await api(bearer, `/api/tasks?workspaceId=${workspaceId}`, { method: "POST", body });
      assert.equal(response.status, 201, await response.clone().text());
      return await response.json() as { id: string; title: string };
    };
    const row = (id: string) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    const tombstone = (id: string) => db.prepare("SELECT * FROM task_deletion_tombstones WHERE id = ?").get(id);
    const settings = { enabled: true, allowWrite: true, publicUrl: "https://note.example.com/mcp" };
    const configure = async (body: typeof settings) => {
      const response = await api("session-admin", "/api/mcp", { method: "PUT", body });
      assert.equal(response.status, 200, await response.clone().text());
    };
    const tool = async (bearer: string, name: string, args: Record<string, unknown>) => {
      const response = await app.request("https://note.example.com/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json() as any).result as ToolResult;
    };
    const confirm = (taskId: string, expectedRevision: string, extra: Record<string, unknown> = {}) =>
      ({ taskId, dryRun: false, expectedRevision, confirmation: "DELETE_TASK", ...extra });
    await configure(settings);

    await t.test("DCC-006: MCP task update rejects extra fields before changing the task", async () => {
      const task = await create("session-owner", { title: "Original task" });
      const before = row(task.id);
      const invalid = await tool(writer, "nowen_update_task", {
        taskId: task.id, title: "Unexpected change", projectId: "other-project",
      });
      assert.equal(invalid.isError, true, text(invalid));
      assert.deepEqual(row(task.id), before);

      const updated = await tool(writer, "nowen_update_task", {
        taskId: task.id, title: "Updated task", description: "Review on Friday", priority: 3, status: "doing",
      });
      assert.equal(updated.isError, undefined, text(updated));
      const saved = json(updated).task;
      assert.equal(saved.title, "Updated task");
      assert.equal(saved.description, "Review on Friday");
      assert.equal(saved.priority, 3);
      assert.equal(saved.status, "doing");
    });

    await t.test("DCC-007: MCP task deletion previews the whole subtree and deletes only after a confirmed, current preview", async () => {
      const root = await create("session-owner", { title: "Wrong study plan" });
      const child = await create("session-owner", { title: "Chapter 1", parentId: root.id });
      const grandchild = await create("session-owner", { title: "Exercise 1", parentId: child.id });
      const keep = await create("session-owner", { title: "Keep this plan" });

      const preview = json(await tool(writer, "nowen_delete_task", { taskId: root.id }));
      assert.equal(preview.dryRun, true);
      assert.equal(preview.recoverable, false);
      assert.equal(preview.affected, 3);
      assert.deepEqual(preview.tasks.map((item: any) => item.id).sort(), [root.id, child.id, grandchild.id].sort());
      assert.equal(preview.tasks[0].id, root.id, "the requested task is listed first");
      assert.match(preview.revision, /^[0-9a-f]{64}$/);
      const snapshot = () => [root.id, child.id, grandchild.id, keep.id].map((id) => [row(id), tombstone(id)]);
      const before = snapshot();
      for (const args of [
        { taskId: root.id, dryRun: false, expectedRevision: preview.revision },
        { taskId: root.id, dryRun: false, confirmation: "DELETE_TASK" },
        confirm(root.id, "0".repeat(64)),
      ]) {
        assert.equal((await tool(writer, "nowen_delete_task", args)).isError, true, JSON.stringify(args));
        assert.deepEqual(snapshot(), before);
      }

      // Another device adds a subtask after the preview; the old confirmation must not delete it.
      const late = await create("session-owner", { title: "Added later", parentId: child.id });
      const beforeStale = [...snapshot(), [row(late.id), tombstone(late.id)]];
      const stale = await tool(writer, "nowen_delete_task", confirm(root.id, preview.revision));
      assert.equal(stale.isError, true);
      assert.match(text(stale), /TASK_DELETION_CONFLICT/);
      assert.deepEqual([...snapshot(), [row(late.id), tombstone(late.id)]], beforeStale);

      const fresh = json(await tool(writer, "nowen_delete_task", { taskId: root.id }));
      assert.equal(fresh.affected, 4);
      const deleted = await tool(writer, "nowen_delete_task", confirm(root.id, fresh.revision));
      assert.equal(deleted.isError, undefined, text(deleted));
      const result = json(deleted);
      assert.equal(result.deleted, true);
      assert.equal(result.affected, 4);
      assert.deepEqual([...result.ids].sort(), [root.id, child.id, grandchild.id, late.id].sort());
      for (const id of result.ids) {
        assert.equal(row(id), undefined);
        assert.equal((tombstone(id) as any)?.userId, "del-owner", "every deleted task leaves a sync tombstone");
      }
      assert.ok(row(keep.id));
      assert.equal(tombstone(keep.id), undefined);
    });

    await t.test("DCC-007: API token task deletion without a current preview and confirmation leaves the task untouched", async () => {
      for (const mode of ["restricted", "unrestricted"]) {
        db.prepare("UPDATE api_tokens SET resourceMode = ? WHERE id = 'del-token-writer'").run(mode);
        const task = await create("session-owner", { title: `Duplicate (${mode})` });
        const previewResponse = await api(writer, `/api/tasks/${task.id}/deletion-preview`);
        assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
        const preview = await previewResponse.json() as { revision: string; affected: number };
        assert.equal(preview.affected, 1);
        const before = row(task.id);
        for (const [body, code] of [
          [undefined, "MCP_PREVIEW_REQUIRED"],
          [{ expectedRevision: preview.revision }, "MCP_CONFIRMATION_REQUIRED"],
          [{ expectedRevision: preview.revision, confirmation: "yes" }, "MCP_CONFIRMATION_REQUIRED"],
          [{ expectedRevision: "f".repeat(64), confirmation: "DELETE_TASK" }, "TASK_DELETION_CONFLICT"],
        ] as const) {
          const response = await api(writer, `/api/tasks/${task.id}`, { method: "DELETE", body });
          assert.equal(response.status, 409, JSON.stringify(body));
          assert.equal((await response.json() as any).code, code);
          assert.deepEqual(row(task.id), before);
          assert.equal(tombstone(task.id), undefined);
        }
        assert.equal((await api(writer, "/api/tasks/batch", { method: "POST", body: { ids: [task.id], action: "delete" } })).status, 403);
        assert.equal((await api(writer, `/api/tasks/${task.id}/recurrence/stop`, { method: "PATCH" })).status, 403);
        assert.deepEqual(row(task.id), before);
        const removed = await api(writer, `/api/tasks/${task.id}`, {
          method: "DELETE", body: { expectedRevision: preview.revision, confirmation: "DELETE_TASK" },
        });
        assert.equal(removed.status, 200, await removed.clone().text());
        assert.deepEqual((await removed.json() as any).ids, [task.id]);
        assert.equal(row(task.id), undefined);
      }
      db.prepare("UPDATE api_tokens SET resourceMode = 'restricted' WHERE id = 'del-token-writer'").run();
    });

    await t.test("app deletion keeps working without a preview while a stale preview revision is refused", async () => {
      const task = await create("session-owner", { title: "Session delete" });
      const stale = await api("session-owner", `/api/tasks/${task.id}`, { method: "DELETE", body: { expectedRevision: "e".repeat(64) } });
      assert.equal(stale.status, 409);
      assert.ok(row(task.id));
      const plain = await api("session-owner", `/api/tasks/${task.id}`, { method: "DELETE" });
      assert.equal(plain.status, 200);
      assert.equal(row(task.id), undefined);
      assert.ok(tombstone(task.id));
    });

    await t.test("DCC-006: task deletion stays inside the token owner's personal tasks, write scope and write-enabled connections", async () => {
      const foreign = await create("session-other", { title: "Not yours" });
      const team = await create("session-owner", { title: "Team task" }, "del-ws");
      for (const id of [foreign.id, team.id]) {
        const before = row(id);
        assert.equal((await tool(writer, "nowen_delete_task", { taskId: id })).isError, true);
        assert.equal((await api(writer, `/api/tasks/${id}/deletion-preview`)).status, 403);
        const response = await api(writer, `/api/tasks/${id}`, {
          method: "DELETE", body: { expectedRevision: "a".repeat(64), confirmation: "DELETE_TASK" },
        });
        assert.equal(response.status, 403);
        assert.deepEqual(row(id), before);
        assert.equal(tombstone(id), undefined);
      }

      const own = await create("session-owner", { title: "Read-only token target" });
      const before = row(own.id);
      const preview = json(await tool(reader, "nowen_delete_task", { taskId: own.id }));
      const scopeDenied = await tool(reader, "nowen_delete_task", confirm(own.id, preview.revision));
      assert.equal(scopeDenied.isError, true);
      assert.match(text(scopeDenied), /tasks:write/);
      assert.deepEqual(row(own.id), before);

      await configure({ ...settings, allowWrite: false });
      try {
        const readOnly = json(await tool(writer, "nowen_delete_task", { taskId: own.id }));
        assert.equal(readOnly.revision, preview.revision, "previews remain available on a read-only connection");
        assert.equal((await tool(writer, "nowen_delete_task", confirm(own.id, readOnly.revision))).isError, true);
        assert.deepEqual(row(own.id), before);
        assert.equal(tombstone(own.id), undefined);
      } finally {
        await configure(settings);
      }
    });

    await t.test("DCC-007: series deletion removes every occurrence and stops the series from regenerating", async () => {
      const first = await create("session-owner", { title: "Daily reading", dueDate: "2026-11-20", repeatRule: "daily" });
      const toggled = await api("session-owner", `/api/tasks/${first.id}/toggle`, { method: "PATCH" });
      const next = (await toggled.json() as any).generatedTask as { id: string };
      assert.ok(next?.id);

      const single = json(await tool(writer, "nowen_delete_task", { taskId: next.id }));
      assert.equal(single.affected, 1);
      assert.equal(single.mayGenerateNextOccurrence, true);
      const series = json(await tool(writer, "nowen_delete_task", { taskId: next.id, mode: "series" }));
      assert.equal(series.affected, 2);
      assert.equal(series.mayGenerateNextOccurrence, false);
      assert.notEqual(series.revision, single.revision);
      assert.equal((await tool(writer, "nowen_delete_task", confirm(next.id, single.revision, { mode: "series" }))).isError, true);
      assert.ok(row(first.id));

      const removed = json(await tool(writer, "nowen_delete_task", confirm(next.id, series.revision, { mode: "series" })));
      assert.deepEqual([...removed.ids].sort(), [first.id, next.id].sort());
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id = ? OR repeatGroupId = ?")
        .get(first.id, first.id) as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT action FROM task_recurrence_state WHERE groupId = ?").get(first.id) as any)?.action, "series");
      for (const id of [first.id, next.id]) assert.ok(tombstone(id));
    });

    await t.test("DCC-006: standalone stdio MCP with a notebook whitelist deletes only confirmed personal tasks", async () => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
      if (!server.listening) await once(server, "listening");
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const personal = await create("session-owner", { title: "Created twice" });
      const team = await create("session-owner", { title: "Team chore" }, "del-ws");

      const readOnly = await startStdioMcp(baseUrl, writer, { ALLOWED_NOTEBOOK_IDS: "", MCP_ACCESS_MODE: "read-only" });
      try {
        const preview = json(await readOnly.call("nowen_delete_task", { taskId: personal.id }));
        assert.equal((await readOnly.call("nowen_delete_task", confirm(personal.id, preview.revision))).isError, true);
        assert.ok(row(personal.id));
      } finally {
        await readOnly.close();
      }

      const stdio = await startStdioMcp(baseUrl, writer, { ALLOWED_NOTEBOOK_IDS: "", MCP_ACCESS_MODE: "read-write" });
      try {
        assert.equal((await stdio.call("nowen_delete_task", { taskId: team.id })).isError, true);
        assert.ok(row(team.id));
        const preview = json(await stdio.call("nowen_delete_task", { taskId: personal.id }));
        const deleted = await stdio.call("nowen_delete_task", confirm(personal.id, preview.revision));
        assert.equal(deleted.isError, undefined, text(deleted));
        assert.deepEqual(json(deleted).ids, [personal.id]);
        assert.equal(row(personal.id), undefined);
        assert.ok(tombstone(personal.id));
      } finally {
        await stdio.close();
      }
    });
  } finally {
    server?.close();
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
