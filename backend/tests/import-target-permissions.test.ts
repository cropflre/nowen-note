import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-import-targets-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
const originalFetch = globalThis.fetch;

function db() {
  return getDb();
}

function seedBase() {
  db().exec(`
    INSERT INTO users (id, username, passwordHash)
    VALUES
      ('owner', 'owner', 'hash'),
      ('editor', 'editor', 'hash'),
      ('viewer', 'viewer', 'hash'),
      ('intruder', 'intruder', 'hash');

    INSERT INTO workspaces (id, name, ownerId)
    VALUES ('ws-1', 'Workspace', 'owner');

    INSERT INTO workspace_members (workspaceId, userId, role)
    VALUES
      ('ws-1', 'owner', 'owner'),
      ('ws-1', 'editor', 'editor'),
      ('ws-1', 'viewer', 'viewer');

    INSERT INTO notebooks (id, userId, workspaceId, name)
    VALUES
      ('nb-ws', 'owner', 'ws-1', 'Workspace notebook'),
      ('nb-owner-personal', 'owner', NULL, 'Owner personal');

    INSERT INTO system_settings (key, value)
    VALUES
      ('ai_provider', 'ollama'),
      ('ai_api_url', 'http://ai.test'),
      ('ai_model', 'test-model');
  `);
}

function resetDb() {
  db().exec(`
    DELETE FROM notes;
    DELETE FROM notebook_members;
    DELETE FROM notebooks;
    DELETE FROM workspace_members;
    DELETE FROM workspaces;
    DELETE FROM system_settings;
    DELETE FROM users;
  `);
  seedBase();
}

function importBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    notes: [
      {
        title: "Imported note",
        content: "{}",
        contentText: "Imported note",
      },
    ],
    ...extra,
  });
}

test.before(async () => {
  const [exportModule, aiModule, schemaModule] = await Promise.all([
    import("../src/routes/export"),
    import("../src/routes/ai"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  app.route("/export", exportModule.default);
  app.route("/ai", aiModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  resetDb();
});

test.beforeEach(() => {
  resetDb();
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "Formatted markdown" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
});

test.after(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("export import rejects workspace writes from non-editor members", async () => {
  const res = await app.request("/export/import?workspaceId=ws-1", {
    method: "POST",
    headers: {
      "X-User-Id": "viewer",
      "Content-Type": "application/json",
    },
    body: importBody(),
  });

  assert.equal(res.status, 403);
  const count = db().prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number };
  assert.equal(count.count, 0);
});

test("export import inherits workspace from an explicit writable notebook before personal gate", async () => {
  db()
    .prepare("UPDATE users SET personalImportEnabled = 0 WHERE id = ?")
    .run("editor");

  const res = await app.request("/export/import", {
    method: "POST",
    headers: {
      "X-User-Id": "editor",
      "Content-Type": "application/json",
    },
    body: importBody({ notebookId: "nb-ws" }),
  });

  assert.equal(res.status, 201);
  const note = db()
    .prepare("SELECT userId, notebookId, workspaceId FROM notes WHERE title = ?")
    .get("Imported note") as
    | { userId: string; notebookId: string; workspaceId: string | null }
    | undefined;
  assert.deepEqual(note, {
    userId: "editor",
    notebookId: "nb-ws",
    workspaceId: "ws-1",
  });
});

test("AI parse-document rejects notebooks the caller cannot write", async () => {
  const form = new FormData();
  form.set("file", new File(["plain text"], "sample.txt", { type: "text/plain" }));
  form.set("notebookId", "nb-owner-personal");

  const res = await app.request("/ai/parse-document", {
    method: "POST",
    headers: { "X-User-Id": "intruder" },
    body: form,
  });

  assert.equal(res.status, 403);
  const count = db().prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number };
  assert.equal(count.count, 0);
});
