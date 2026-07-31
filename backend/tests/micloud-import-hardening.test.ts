import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { Hono } from "hono";
import "../src/runtime/knowledge-tree-migration-bootstrap.js";
import { getDb, closeDb } from "../src/db/schema.js";
import miCloudRouter from "../src/routes/micloud.js";
import "../src/runtime/micloud-import-hardening.js";

const USER_ID = "micloud-test-user";
const originalFetch = globalThis.fetch;

function resetDatabase(): void {
  const db = getDb();
  db.exec(`
    DROP TRIGGER IF EXISTS micloud_test_fail_note;
    DELETE FROM note_import_origins;
    DELETE FROM notes;
    DELETE FROM notebooks;
    DELETE FROM users;
  `);
  db.prepare(`
    INSERT INTO users (id, username, passwordHash, role)
    VALUES (?, ?, ?, 'admin')
  `).run(USER_ID, `micloud-${Date.now()}`, "test-password-hash");
}

function installMiCloudFetchMock(): void {
  globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    const rawUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const url = new URL(rawUrl);
    const match = url.pathname.match(/\/note\/note\/([^/]+)\/?$/);
    if (!match) {
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const noteId = decodeURIComponent(match[1]);
    const title = noteId === "bad-note" ? "Bad note" : `Title ${noteId}`;
    return new Response(JSON.stringify({
      code: 0,
      data: {
        entry: {
          id: noteId,
          subject: title,
          content: `<size>${title}</size>\n正文 ${noteId}`,
          createDate: 1_420_070_400_000,
          modifyDate: 1_420_070_460_000,
        },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function createApp(): Hono {
  const app = new Hono();
  app.route("/api/micloud", miCloudRouter);
  return app;
}

async function importNotes(app: Hono, noteIds: string[]) {
  const response = await app.request("/api/micloud/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": USER_ID,
    },
    body: JSON.stringify({ cookie: "serviceToken=test", noteIds }),
  });
  const payload = await response.json() as any;
  return { response, payload };
}

beforeEach(() => {
  resetDatabase();
  installMiCloudFetchMock();
});

after(() => {
  globalThis.fetch = originalFetch;
  closeDb();
});

test("isolates each Xiaomi note and stores imported content as HTML", async () => {
  const app = createApp();
  const { response, payload } = await importNotes(app, ["note-1", "note-2"]);

  assert.equal(response.status, 201);
  assert.equal(payload.success, true);
  assert.equal(payload.count, 2);
  assert.equal(payload.createdCount, 2);
  assert.equal(payload.skippedCount, 0);

  const rows = getDb().prepare(`
    SELECT title, contentFormat, workspaceId, contentText
    FROM notes
    ORDER BY title
  `).all() as Array<{
    title: string;
    contentFormat: string;
    workspaceId: string | null;
    contentText: string;
  }>;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.contentFormat === "html"));
  assert.ok(rows.every((row) => row.workspaceId === null));
  assert.ok(rows.every((row) => row.contentText.includes("正文")));

  const originCount = getDb().prepare(
    "SELECT COUNT(*) AS count FROM note_import_origins WHERE sourceType = 'xiaomi-note'",
  ).get() as { count: number };
  assert.equal(originCount.count, 2);
});

test("ignores a deleted Xiaomi notebook and creates a new active personal target", async () => {
  const db = getDb();
  const deletedNotebookId = "deleted-xiaomi-notebook";
  db.prepare(`
    INSERT INTO notebooks (id, userId, workspaceId, name, icon, isDeleted, deletedAt)
    VALUES (?, ?, NULL, '小米云笔记', '📱', 1, datetime('now'))
  `).run(deletedNotebookId, USER_ID);

  const app = createApp();
  const { response, payload } = await importNotes(app, ["note-after-delete"]);

  assert.equal(response.status, 201);
  assert.equal(payload.success, true);
  assert.equal(payload.createdCount, 1);
  assert.notEqual(payload.notebookId, deletedNotebookId);

  const activeNotebooks = db.prepare(`
    SELECT id, workspaceId, isDeleted
    FROM notebooks
    WHERE userId = ? AND name = '小米云笔记' AND isDeleted = 0
  `).all(USER_ID) as Array<{ id: string; workspaceId: string | null; isDeleted: number }>;
  assert.equal(activeNotebooks.length, 1);
  assert.equal(activeNotebooks[0].workspaceId, null);

  const note = db.prepare(`
    SELECT notebookId, workspaceId
    FROM notes
    WHERE title = 'Title note-after-delete'
  `).get() as { notebookId: string; workspaceId: string | null };
  assert.equal(note.notebookId, activeNotebooks[0].id);
  assert.equal(note.workspaceId, null);
});

test("retries are idempotent and do not duplicate already imported Xiaomi notes", async () => {
  const app = createApp();
  const first = await importNotes(app, ["note-1", "note-2"]);
  assert.equal(first.response.status, 201);

  const second = await importNotes(app, ["note-1", "note-2"]);
  assert.equal(second.response.status, 201);
  assert.equal(second.payload.count, 2);
  assert.equal(second.payload.createdCount, 0);
  assert.equal(second.payload.skippedCount, 2);

  const row = getDb().prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number };
  assert.equal(row.count, 2);
});

test("one database failure no longer rolls back the other notes or returns a plain batch 500", async () => {
  const db = getDb();
  db.exec(`
    CREATE TRIGGER micloud_test_fail_note
    BEFORE INSERT ON notes
    WHEN NEW.title = 'Bad note'
    BEGIN
      SELECT RAISE(ABORT, 'forced Xiaomi note failure');
    END;
  `);

  const app = createApp();
  const { response, payload } = await importNotes(app, ["good-note", "bad-note"]);

  assert.equal(response.status, 201);
  assert.equal(payload.success, true);
  assert.equal(payload.count, 1);
  assert.equal(payload.createdCount, 1);
  assert.equal(payload.errors.length, 1);
  assert.match(payload.errors[0], /bad-note/);
  assert.match(payload.errors[0], /forced Xiaomi note failure/);

  const notes = db.prepare("SELECT title FROM notes ORDER BY title").all() as Array<{ title: string }>;
  assert.deepEqual(notes.map((row) => row.title), ["Title good-note"]);
});
