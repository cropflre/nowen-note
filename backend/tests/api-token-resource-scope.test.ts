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

before(async () => {
  const schemaModule = await import("../src/db/schema");
  const tokenModule = await import("../src/lib/api-tokens");
  const scopeModule = await import("../src/middleware/api-token-resource-scope");
  db = schemaModule.getDb();
  tokenModule.initApiTokensTable(db);
  enforceApiTokenAccess = scopeModule.enforceApiTokenAccess;

  db.exec(`
    INSERT OR IGNORE INTO users (id, username, passwordHash)
    VALUES ('user-1', 'user-1', 'hash');

    INSERT OR IGNORE INTO notebooks (id, userId, name, isDeleted)
    VALUES
      ('nb-a', 'user-1', 'Allowed', 0),
      ('nb-b', 'user-1', 'Denied', 0),
      ('nb-a-child', 'user-1', 'Allowed child', 0);
    UPDATE notebooks SET parentId = 'nb-a' WHERE id = 'nb-a-child';

    INSERT OR IGNORE INTO notes (id, userId, notebookId, title)
    VALUES
      ('note-a', 'user-1', 'nb-a', 'Allowed note'),
      ('note-b', 'user-1', 'nb-b', 'Denied note'),
      ('note-child', 'user-1', 'nb-a-child', 'Child note');

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
