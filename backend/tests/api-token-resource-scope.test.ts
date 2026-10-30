import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, beforeEach } from "node:test";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-token-scope-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let db: any;
let enforceApiTokenAccess: any;

test("PAT reminder scopes persist personal reminders and reject foreign, team and privileged routes", async () => {
  const { default: reminders } = await import("../src/routes/task-reminders");
  const { default: tasks } = await import("../src/routes/tasks");
  db.exec(`INSERT OR IGNORE INTO tasks(id,userId,title,workspaceId,dueDate,dueAt) VALUES
    ('reminder-own','user-1','Mine',NULL,'2099-10-21','2099-10-21T09:30'),
    ('reminder-foreign','user-2','Other',NULL,'2099-10-21',NULL),
    ('reminder-team','user-2','Team','ws-1','2099-10-21',NULL)`);
  for (const mode of ["restricted", "unrestricted"]) {
    const app = new Hono();
    let scopes = "tasks:read,tasks:write";
    app.use("*", async (c, next) => {
      c.req.raw.headers.set("X-Auth-Mode", "api-token");
      c.req.raw.headers.set("X-Api-Token-Id", "token-1");
      c.req.raw.headers.set("X-Api-Resource-Mode", mode);
      c.req.raw.headers.set("X-Api-Scopes", scopes);
      c.req.raw.headers.set("X-User-Id", "user-1");
      return enforceApiTokenAccess(c, next);
    });
    app.route("/api/task-reminders", reminders);
    app.route("/api/tasks", tasks);
    const child = await app.request("/api/tasks?workspaceId=personal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Timed child", parentId: "reminder-own", dueDate: "2099-10-21", dueAt: "2099-10-21T09:30" }),
    });
    assert.equal(child.status, 201);
    const childId = (await child.json() as any).id;
    const reopened = await (await app.request(`/api/tasks/${childId}`)).json() as any;
    assert.equal(reopened.parentId, "reminder-own");
    assert.equal(reopened.dueAt, "2099-10-21T09:30");
    const create = (id: string) => app.request(`/api/task-reminders/${id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offsetMinutes: 30, timezoneOffsetMinutes: -480 }),
    });
    const created = await create("reminder-own");
    assert.equal(created.status, 201);
    const saved = await created.json() as any;
    assert.equal(saved.timezoneOffsetMinutes, -480);
    const read = await app.request("/api/task-reminders/reminder-own");
    assert.equal(read.status, 200);
    assert.ok((await read.json() as any[]).some(row => row.id === saved.id && row.offsetMinutes === 30));
    const { scanDueReminders } = await import("../src/routes/task-reminders");
    const originalNow = Date.now;
    try {
      Date.now = () => Date.parse("2099-10-21T00:59:59Z");
      assert.ok(!scanDueReminders().some(row => row.reminderId === saved.id));
      Date.now = () => Date.parse("2099-10-21T01:00:00Z");
      assert.ok(scanDueReminders().some(row => row.reminderId === saved.id));
    } finally { Date.now = originalNow; }
    assert.equal((await create("reminder-foreign")).status, 403);
    assert.equal((await create("reminder-team")).status, 403);
    for (const id of ["reminder-foreign", "reminder-team", "overview", "schedule", "recent"]) {
      assert.equal((await app.request(`/api/task-reminders/${id}`)).status, 403);
    }
    assert.equal((await create("test-now")).status, 403);
    assert.equal((await app.request(`/api/task-reminders/${saved.id}`, { method: "DELETE" })).status, 403);
    assert.equal((await app.request("/api/task-reminders/recent/ack", { method: "POST" })).status, 403);
    scopes = "tasks:read";
    assert.equal((await create("reminder-own")).status, 403);
    assert.equal((await app.request("/api/task-reminders/reminder-own")).status, 200);
    scopes = "notes:read";
    assert.equal((await app.request("/api/task-reminders/reminder-own")).status, 403);
    db.prepare("DELETE FROM task_reminders WHERE id = ?").run(saved.id);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(childId);
  }
});

before(async () => {
  const schemaModule = await import("../src/db/schema");
  const tokenModule = await import("../src/lib/api-tokens");
  const scopeModule = await import("../src/middleware/api-token-resource-scope");
  db = schemaModule.getDb();
  tokenModule.initApiTokensTable(db);
  enforceApiTokenAccess = scopeModule.enforceApiTokenAccess;

  db.exec(`
    INSERT OR IGNORE INTO users (id, username, passwordHash)
    VALUES
      ('user-1', 'user-1', 'hash'),
      ('user-2', 'user-2', 'hash');

    INSERT OR IGNORE INTO workspaces (id, name, ownerId)
    VALUES ('ws-1', 'Team Space', 'user-2');

    INSERT OR IGNORE INTO workspace_members (workspaceId, userId, role)
    VALUES
      ('ws-1', 'user-2', 'owner'),
      ('ws-1', 'user-1', 'editor');

    INSERT OR IGNORE INTO notebooks (id, userId, name, isDeleted)
    VALUES
      ('nb-a', 'user-1', 'Allowed', 0),
      ('nb-b', 'user-1', 'Denied', 0),
      ('nb-a-child', 'user-1', 'Allowed child', 0);
    UPDATE notebooks SET parentId = 'nb-a' WHERE id = 'nb-a-child';

    INSERT OR IGNORE INTO notebooks (id, userId, workspaceId, name, isDeleted)
    VALUES
      ('nb-ws', 'user-2', 'ws-1', 'Workspace Allowed', 0),
      ('nb-ws-child', 'user-2', 'ws-1', 'Workspace Child', 0);
    UPDATE notebooks SET parentId = 'nb-ws' WHERE id = 'nb-ws-child';

    INSERT OR IGNORE INTO notes (id, userId, notebookId, title)
    VALUES
      ('note-a', 'user-1', 'nb-a', 'Allowed note'),
      ('note-b', 'user-1', 'nb-b', 'Denied note'),
      ('note-child', 'user-1', 'nb-a-child', 'Child note'),
      ('note-ws', 'user-2', 'nb-ws', 'Workspace note'),
      ('note-ws-child', 'user-2', 'nb-ws-child', 'Workspace child note');
    UPDATE notes SET workspaceId = 'ws-1' WHERE id IN ('note-ws', 'note-ws-child');

    INSERT OR IGNORE INTO api_tokens
      (id, userId, name, tokenHash, scopes, resourceMode)
    VALUES
      ('token-1', 'user-1', 'Agent', 'hash-token',
       '["notes:read","notes:write","notebooks:read","tags:write"]', 'restricted');
  `);
});

beforeEach(() => {
  db.prepare("DELETE FROM api_token_resources WHERE tokenId = ?").run("token-1");
  db.prepare(`
    INSERT INTO api_token_resources
      (id, tokenId, resourceType, resourceId, permission, includeDescendants)
    VALUES ('resource-1', 'token-1', 'notebook', 'nb-a', 'read', 1)
  `).run();
});

function createApp(resourceMode: "restricted" | "unrestricted" = "restricted") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.req.raw.headers.set("X-Auth-Mode", "api-token");
    c.req.raw.headers.set("X-Api-Token-Id", "token-1");
    c.req.raw.headers.set("X-Api-Resource-Mode", resourceMode);
    c.req.raw.headers.set("X-Api-Scopes", "notes:read,notes:write,notebooks:read,tags:write");
    c.req.raw.headers.set("X-User-Id", "user-1");
    return enforceApiTokenAccess(c, next);
  });
  // 模拟历史 /api/notebooks 默认只返回个人空间。restricted Token 中间件需要基于
  // grant + 当前 ACL 补全工作区笔记本，而不是被这个默认查询范围限制。
  app.get("/api/notebooks", (c) => c.json([
    { id: "nb-a", name: "Allowed", workspaceId: null },
    { id: "nb-b", name: "Denied", workspaceId: null },
    { id: "nb-a-child", name: "Allowed child", workspaceId: null },
  ]));
  app.get("/api/notes", (c) => c.json([
    { id: "note-a", notebookId: "nb-a", title: "Allowed note" },
    { id: "note-b", notebookId: "nb-b", title: "Denied note" },
    { id: "note-child", notebookId: "nb-a-child", title: "Child note" },
  ]));
  app.get("/api/notes/:id", (c) => c.json({ id: c.req.param("id") }));
  app.put("/api/notes/:id", (c) => c.json({ id: c.req.param("id"), updated: true }));
  app.post("/api/tags", (c) => c.json({ created: true }, 201));
  app.get("/api/backups", (c) => c.json({ backups: [] }));
  return app;
}

test("filters note collections to granted notebook and descendants", async () => {
  const response = await createApp().request("/api/notes");
  assert.equal(response.status, 200);
  const body = await response.json() as Array<{ id: string }>;
  assert.deepEqual(body.map((item) => item.id), ["note-a", "note-child"]);
});

test("discovers granted workspace notebooks and descendants even when the route defaults to personal space", async () => {
  db.prepare("DELETE FROM api_token_resources WHERE tokenId = ?").run("token-1");
  db.prepare(`
    INSERT INTO api_token_resources
      (id, tokenId, resourceType, resourceId, permission, includeDescendants)
    VALUES ('resource-ws', 'token-1', 'notebook', 'nb-ws', 'write', 1)
  `).run();

  const response = await createApp().request("/api/notebooks");
  assert.equal(response.status, 200);
  const body = await response.json() as Array<{
    id: string;
    workspaceId: string | null;
    workspaceName?: string | null;
  }>;

  assert.deepEqual(body.map((item) => item.id), ["nb-ws", "nb-ws-child"]);
  assert.equal(body[0]?.workspaceId, "ws-1");
  assert.equal(body[0]?.workspaceName, "Team Space");
});

test("workspace grant permits direct note read and write after discovery", async () => {
  db.prepare("DELETE FROM api_token_resources WHERE tokenId = ?").run("token-1");
  db.prepare(`
    INSERT INTO api_token_resources
      (id, tokenId, resourceType, resourceId, permission, includeDescendants)
    VALUES ('resource-ws-rw', 'token-1', 'notebook', 'nb-ws', 'write', 1)
  `).run();

  const readResponse = await createApp().request("/api/notes/note-ws-child");
  assert.equal(readResponse.status, 200);
  const readBody = await readResponse.json() as { id: string };
  assert.equal(readBody.id, "note-ws-child");

  const writeResponse = await createApp().request("/api/notes/note-ws", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "changed" }),
  });
  assert.equal(writeResponse.status, 200);
  const writeBody = await writeResponse.json() as { updated: boolean };
  assert.equal(writeBody.updated, true);
});

test("workspace grant stops being discoverable after the user loses workspace ACL", async () => {
  db.prepare("DELETE FROM api_token_resources WHERE tokenId = ?").run("token-1");
  db.prepare(`
    INSERT INTO api_token_resources
      (id, tokenId, resourceType, resourceId, permission, includeDescendants)
    VALUES ('resource-ws-revoked', 'token-1', 'notebook', 'nb-ws', 'read', 1)
  `).run();
  db.prepare("DELETE FROM workspace_members WHERE workspaceId = ? AND userId = ?").run("ws-1", "user-1");

  try {
    const response = await createApp().request("/api/notebooks");
    assert.equal(response.status, 200);
    const body = await response.json() as Array<{ id: string }>;
    assert.deepEqual(body, []);
  } finally {
    db.prepare("INSERT OR IGNORE INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
      .run("ws-1", "user-1", "editor");
  }
});

test("denies direct read by known noteId outside resource scope", async () => {
  const response = await createApp().request("/api/notes/note-b");
  assert.equal(response.status, 403);
  const body = await response.json() as { code: string };
  assert.equal(body.code, "API_TOKEN_RESOURCE_DENIED");
});

test("read grant rejects writes", async () => {
  const response = await createApp().request("/api/notes/note-a", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "changed" }),
  });
  assert.equal(response.status, 403);
});

test("write grant permits writes", async () => {
  db.prepare("UPDATE api_token_resources SET permission = 'write' WHERE id = 'resource-1'").run();
  const response = await createApp().request("/api/notes/note-a", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "changed" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { updated: boolean };
  assert.equal(body.updated, true);
});

test("restricted token with empty resource list fails closed", async () => {
  db.prepare("DELETE FROM api_token_resources WHERE tokenId = 'token-1'").run();
  const response = await createApp().request("/api/notes/note-a");
  assert.equal(response.status, 403);
});

test("unrestricted legacy token keeps access to unmapped endpoints", async () => {
  const response = await createApp("unrestricted").request("/api/backups");
  assert.equal(response.status, 200);
});

test("restricted token denies unmapped endpoints", async () => {
  const response = await createApp("restricted").request("/api/backups");
  assert.equal(response.status, 403);
  const body = await response.json() as { code: string };
  assert.equal(body.code, "API_TOKEN_ENDPOINT_DENIED");
});

test("restricted token cannot create global tags", async () => {
  const response = await createApp().request("/api/tags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "global" }),
  });
  assert.equal(response.status, 403);
});

test("PAT task scopes isolate personal tasks even with unrestricted token mode", async () => {
  db.exec(`
    INSERT OR IGNORE INTO tasks(id,userId,title,workspaceId) VALUES
      ('token-own-task','user-1','Mine',NULL),
      ('token-other-task','user-2','Other',NULL),
      ('token-team-task','user-2','Team','ws-1');
  `);
  for (const mode of ["restricted", "unrestricted"]) {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.req.raw.headers.set("X-Auth-Mode", "api-token");
      c.req.raw.headers.set("X-Api-Token-Id", "token-1");
      c.req.raw.headers.set("X-Api-Resource-Mode", mode);
      c.req.raw.headers.set("X-Api-Scopes", "tasks:read,tasks:write");
      c.req.raw.headers.set("X-User-Id", "user-1");
      return enforceApiTokenAccess(c, next);
    });
    app.get("/api/tasks/:id", (c) => c.json({
      id: c.req.param("id"), children: [{ userId: "user-2", workspaceId: null }, { userId: "user-1", workspaceId: null }],
    }));
    app.put("/api/tasks/:id", (c) => c.json({ updated: c.req.param("id") }));
    app.get("/api/tasks", (c) => c.json([]));
    assert.equal((await app.request("/api/tasks/token-other-task")).status, 403);
    assert.equal((await app.request("/api/tasks/token-team-task")).status, 403);
    assert.equal((await app.request("/api/tasks?workspaceId=ws-1")).status, 403);
    const result = await app.request("/api/tasks/token-own-task");
    assert.equal(result.status, 200);
    assert.equal(((await result.json()) as any).children.length, 1);
    assert.equal((await app.request("/api/tasks/token-other-task", { method: "PUT" })).status, 403);
    assert.equal((await app.request("/api/tasks/reorder/batch", { method: "PUT" })).status, 403);
  }
});

test("PAT personal task projects remain available but workspace projects are denied", async () => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.req.raw.headers.set("X-Auth-Mode", "api-token");
    c.req.raw.headers.set("X-Api-Token-Id", "token-1");
    c.req.raw.headers.set("X-Api-Resource-Mode", "restricted");
    c.req.raw.headers.set("X-Api-Scopes", "tasks:read,tasks:write");
    c.req.raw.headers.set("X-User-Id", "user-1");
    return enforceApiTokenAccess(c, next);
  });
  app.get("/api/task-projects", (c) => c.json([]));
  app.post("/api/task-projects", (c) => c.json({ created: true }, 201));
  app.put("/api/task-projects/:id", (c) => c.json({ updated: true }));

  assert.equal((await app.request("/api/task-projects?workspaceId=personal")).status, 200);
  assert.equal((await app.request("/api/task-projects?workspaceId=ws-1")).status, 403);
  assert.equal((await app.request("/api/task-projects?workspaceId=personal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Personal" }),
  })).status, 201);
  assert.equal((await app.request("/api/task-projects?workspaceId=personal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Bad", workspaceId: "ws-1" }),
  })).status, 403);
  assert.equal((await app.request("/api/task-projects/unknown-project", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Other" }),
  })).status, 403);
});

test("PAT filtered knowledge tree does not leak unauthorized notebook descendants", async () => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.req.raw.headers.set("X-Auth-Mode", "api-token");
    c.req.raw.headers.set("X-Api-Token-Id", "token-1");
    c.req.raw.headers.set("X-Api-Resource-Mode", "restricted");
    c.req.raw.headers.set("X-Api-Scopes", "notebooks:read");
    c.req.raw.headers.set("X-User-Id", "user-1");
    return enforceApiTokenAccess(c, next);
  });
  app.get("/api/knowledge-tree/", (c) => c.json({
    nodes: [
      { id: "notebook:nb-a", parentId: null, resourceType: "notebook", resourceId: "nb-a" },
      { id: "note:note-a", parentId: "notebook:nb-a", resourceType: "note", resourceId: "note-a" },
      { id: "notebook:nb-b", parentId: null, resourceType: "notebook", resourceId: "nb-b" },
      { id: "note:note-b", parentId: "notebook:nb-b", resourceType: "note", resourceId: "note-b" },
    ],
    passwordAuthorizedNotes: [
      { noteId: "note-a", folderIds: [] },
      { noteId: "note-b", folderIds: [] },
    ],
  }));
  app.put("/api/knowledge-tree/nodes/note:note-a/move", (c) => c.json({ moved: true }));

  const response = await app.request("/api/knowledge-tree/");
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.deepEqual(body.nodes.map((node: any) => node.id), ["notebook:nb-a", "note:note-a"]);
  assert.deepEqual(body.passwordAuthorizedNotes.map((entry: any) => entry.noteId), ["note-a"]);
  assert.equal((await app.request("/api/knowledge-tree/nodes/note:note-a/move", {
    method: "PUT",
  })).status, 403);
});

test("PAT may create only personal subtasks; foreign and team parents are denied", async () => {
  db.exec(`
    INSERT OR IGNORE INTO tasks (id, userId, title, workspaceId) VALUES
      ('mcp-own-parent', 'user-1', 'Own parent', NULL),
      ('mcp-foreign-parent', 'user-2', 'Other parent', NULL),
      ('mcp-team-parent', 'user-2', 'Team parent', 'ws-1');
  `);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.req.raw.headers.set("X-Auth-Mode", "api-token");
    c.req.raw.headers.set("X-Api-Token-Id", "token-1");
    c.req.raw.headers.set("X-Api-Resource-Mode", "restricted");
    c.req.raw.headers.set("X-Api-Scopes", "tasks:write");
    c.req.raw.headers.set("X-User-Id", "user-1");
    return enforceApiTokenAccess(c, next);
  });
  app.post("/api/tasks", (c) => c.json({ created: true }, 201));
  const create = (parentId: string) => app.request("/api/tasks?workspaceId=personal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Child", parentId }),
  });
  assert.equal((await create("mcp-own-parent")).status, 201);
  assert.equal((await create("mcp-foreign-parent")).status, 403);
  assert.equal((await create("mcp-team-parent")).status, 403);
});

test("P1 personal file-manager PAT forbids restricted global folder access and foreign file writes", async () => {
  db.prepare(`INSERT OR IGNORE INTO attachments
    (id, noteId, userId, workspaceId, filename, mimeType, size, path, uploadSource)
    VALUES (?, ?, ?, NULL, ?, 'application/pdf', 100, ?, ?)`)
    .run("p1-managed", "note-a", "user-1", "owned.pdf", "stored-p1-managed", "file_manager");
  db.prepare(`INSERT OR IGNORE INTO attachments
    (id, noteId, userId, workspaceId, filename, mimeType, size, path, uploadSource)
    VALUES (?, ?, ?, NULL, ?, 'application/pdf', 100, ?, ?)`)
    .run("p1-note-asset", "note-a", "user-1", "editor.pdf", "stored-p1-editor", "note");
  db.prepare(`INSERT OR IGNORE INTO attachments
    (id, noteId, userId, workspaceId, filename, mimeType, size, path, uploadSource)
    VALUES (?, ?, ?, NULL, ?, 'application/pdf', 100, ?, ?)`)
    .run("p1-foreign", "note-b", "user-2", "foreign.pdf", "stored-p1-foreign", "file_manager");

  function makeApp(mode: "restricted" | "unrestricted") {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.req.raw.headers.set("X-Auth-Mode", "api-token");
      c.req.raw.headers.set("X-Api-Token-Id", "token-1");
      c.req.raw.headers.set("X-Api-Resource-Mode", mode);
      c.req.raw.headers.set("X-Api-Scopes", "notes:read,attachments:write");
      c.req.raw.headers.set("X-User-Id", "user-1");
      return enforceApiTokenAccess(c, next);
    });
    app.get("/api/attachment-folders", (c) => c.json({ folders: [] }));
    app.post("/api/attachment-folders", (c) => c.json({ created: true }, 201));
    app.patch("/api/files/:id", (c) => c.json({ updated: c.req.param("id") }));
    app.post("/api/files/batch-move", (c) => c.json({ moved: true }));
    app.post("/api/files/trash/purge", (c) => c.json({ deleted: true }));
    return app;
  }
  assert.equal((await makeApp("restricted").request("/api/attachment-folders")).status, 403);
  assert.equal((await makeApp("unrestricted").request("/api/attachment-folders?workspaceId=personal")).status, 200);
  assert.equal((await makeApp("unrestricted").request("/api/attachment-folders?workspaceId=ws-1")).status, 403);
  const request = (url: string, body: unknown) => makeApp("unrestricted").request(url, {
    method: url.includes("batch-move") ? "POST" : "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal((await request("/api/files/p1-managed", {
    filename: "renamed.pdf", expectedFilename: "owned.pdf",
  })).status, 200);
  assert.equal((await request("/api/files/p1-managed", { filename: "bad.pdf" })).status, 409);
  assert.equal((await request("/api/files/p1-note-asset", {
    filename: "bad.pdf", expectedFilename: "editor.pdf",
  })).status, 403);
  assert.equal((await request("/api/files/p1-foreign", {
    filename: "stolen.pdf", expectedFilename: "foreign.pdf",
  })).status, 403);
  assert.equal((await request("/api/files/batch-move", {
    ids: ["p1-managed"], folderId: null, expectedFolderIds: { "p1-managed": null },
  })).status, 200);
  assert.equal((await request("/api/files/batch-move", {
    ids: ["p1-managed", "p1-foreign"], folderId: null,
    expectedFolderIds: { "p1-managed": null, "p1-foreign": null },
  })).status, 403);
  assert.equal((await makeApp("unrestricted").request("/api/files/trash/purge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: ["p1-managed"], confirmation: "PERMANENTLY_DELETE" }),
  })).status, 403);
});

test("P1 task snapshot PAT requires owned personal task, writable notebook and exact task revision", async () => {
  db.prepare("UPDATE api_token_resources SET permission='write' WHERE id='resource-1'").run();
  db.prepare("INSERT OR IGNORE INTO tasks(id,userId,title,workspaceId,updatedAt) VALUES(?,?,?,NULL,?)")
    .run("p1-task", "user-1", "Personal", "2026-10-16T09:00:00Z");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.req.raw.headers.set("X-Auth-Mode", "api-token");
    c.req.raw.headers.set("X-Api-Token-Id", "token-1");
    c.req.raw.headers.set("X-Api-Resource-Mode", "restricted");
    c.req.raw.headers.set("X-Api-Scopes", "tasks:write,notes:write");
    c.req.raw.headers.set("X-User-Id", "user-1");
    return enforceApiTokenAccess(c, next);
  });
  app.post("/api/tasks/:id/note", (c) => c.json({ taskId: c.req.param("id"), saved: true }, 201));
  const call = (taskId: string, notebookId: string, expectedTaskUpdatedAt: string) => app.request(
    `/api/tasks/${taskId}/note?workspaceId=personal`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebookId, expectedTaskUpdatedAt,
        expectedTaskTitle: "Personal", expectedTaskDescription: "" }) },
  );
  assert.equal((await call("p1-task", "nb-a", "stale")).status, 409);
  assert.equal((await call("p1-task", "nb-b", "2026-10-16T09:00:00Z")).status, 403);
  assert.equal((await call("p1-task", "nb-a", "2026-10-16T09:00:00Z")).status, 201);
  assert.equal((await call("token-other-task", "nb-a", "2026-10-16T09:00:00Z")).status, 403);
});
