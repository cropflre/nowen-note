import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-export-import-deleted-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

const USER_ID = "user-import-deleted";

function db() {
  return getDb();
}

function resetDb() {
  db().exec(`
    DELETE FROM attachment_references;
    DELETE FROM attachments;
    DELETE FROM favorites;
    DELETE FROM notes;
    DELETE FROM notebook_members;
    DELETE FROM notebooks;
    DELETE FROM workspace_members;
    DELETE FROM workspaces;
    DELETE FROM users;
  `);
}

function seedUser() {
  db()
    .prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
}

async function importOne(notebookPath: string[], title = "Imported Note") {
  const res = await app.request("/export/import?workspaceId=personal", {
    method: "POST",
    headers: {
      "X-User-Id": USER_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      notes: [{
        title,
        content: "{}",
        contentText: title,
        notebookPath,
      }],
    }),
  });
  if (res.status !== 201) {
    assert.equal(res.status, 201, await res.text());
  }
  return res.json() as Promise<{
    notebookId: string;
    notebookIds: string[];
    notes: { id: string; notebookId: string }[];
  }>;
}

async function deleteNotebook(id: string) {
  const res = await app.request(`/notebooks/${id}`, {
    method: "DELETE",
    headers: { "X-User-Id": USER_ID },
  });
  if (res.status !== 200) {
    assert.equal(res.status, 200, await res.text());
  }
}

test.before(async () => {
  const [exportModule, notebooksModule, notesModule, schemaModule] = await Promise.all([
    import("../src/routes/export"),
    import("../src/routes/notebooks"),
    import("../src/routes/notes"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  app.route("/export", exportModule.default);
  app.route("/notebooks", notebooksModule.default);
  app.route("/notes", notesModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
});

test.beforeEach(() => {
  resetDb();
  seedUser();
});

test.after(async () => {
  closeDb();
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (err?.code !== "EBUSY") throw err;
      if (i === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

test("import recreates a visible notebook instead of reusing a soft-deleted one", async () => {
  const first = await importOne(["SiYuan User Guide"], "First Import");
  const oldNotebookId = first.notebookId;

  await deleteNotebook(oldNotebookId);

  const oldNotebook = db()
    .prepare("SELECT id, isDeleted FROM notebooks WHERE id = ?")
    .get(oldNotebookId) as { id: string; isDeleted: number };
  assert.equal(oldNotebook.isDeleted, 1);

  const second = await importOne(["SiYuan User Guide"], "Second Import");
  const newNotebookId = second.notebookId;
  assert.notEqual(newNotebookId, oldNotebookId);

  const rows = db()
    .prepare("SELECT id, isDeleted FROM notebooks WHERE userId = ? AND name = ? ORDER BY createdAt ASC")
    .all(USER_ID, "SiYuan User Guide") as { id: string; isDeleted: number }[];
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.id === oldNotebookId)?.isDeleted, 1);
  assert.equal(rows.find((row) => row.id === newNotebookId)?.isDeleted, 0);

  const newNote = db()
    .prepare("SELECT notebookId, isTrashed FROM notes WHERE id = ?")
    .get(second.notes[0].id) as { notebookId: string; isTrashed: number };
  assert.equal(newNote.notebookId, newNotebookId);
  assert.equal(newNote.isTrashed, 0);

  const notebooksRes = await app.request("/notebooks?workspaceId=personal", {
    headers: { "X-User-Id": USER_ID },
  });
  assert.equal(notebooksRes.status, 200);
  const visibleNotebooks = await notebooksRes.json() as { id: string; name: string }[];
  assert.ok(visibleNotebooks.some((nb) => nb.id === newNotebookId && nb.name === "SiYuan User Guide"));
  assert.ok(!visibleNotebooks.some((nb) => nb.id === oldNotebookId));

  const notesRes = await app.request(`/notes?workspaceId=personal&notebookId=${newNotebookId}`, {
    headers: { "X-User-Id": USER_ID },
  });
  assert.equal(notesRes.status, 200);
  const visibleNotes = await notesRes.json() as { id: string; title: string }[];
  assert.ok(visibleNotes.some((note) => note.id === second.notes[0].id && note.title === "Second Import"));
});

test("import recreates a full visible hierarchy when the old hierarchy is soft-deleted", async () => {
  const first = await importOne(["SiYuan User Guide", "Child"], "First Child");
  const oldChildId = first.notebookId;
  const oldChild = db()
    .prepare("SELECT id, parentId FROM notebooks WHERE id = ?")
    .get(oldChildId) as { id: string; parentId: string };
  const oldRootId = oldChild.parentId;

  await deleteNotebook(oldRootId);

  const second = await importOne(["SiYuan User Guide", "Child"], "Second Child");
  const newChildId = second.notebookId;
  const newChild = db()
    .prepare("SELECT id, parentId, isDeleted FROM notebooks WHERE id = ?")
    .get(newChildId) as { id: string; parentId: string; isDeleted: number };
  const newRoot = db()
    .prepare("SELECT id, name, isDeleted FROM notebooks WHERE id = ?")
    .get(newChild.parentId) as { id: string; name: string; isDeleted: number };

  assert.notEqual(newRoot.id, oldRootId);
  assert.notEqual(newChildId, oldChildId);
  assert.equal(newRoot.name, "SiYuan User Guide");
  assert.equal(newRoot.isDeleted, 0);
  assert.equal(newChild.isDeleted, 0);

  const oldRows = db()
    .prepare(`SELECT id, isDeleted FROM notebooks WHERE id IN (?, ?)`)
    .all(oldRootId, oldChildId) as { id: string; isDeleted: number }[];
  assert.equal(oldRows.find((row) => row.id === oldRootId)?.isDeleted, 1);
  assert.equal(oldRows.find((row) => row.id === oldChildId)?.isDeleted, 1);

  const newNote = db()
    .prepare("SELECT notebookId, isTrashed FROM notes WHERE id = ?")
    .get(second.notes[0].id) as { notebookId: string; isTrashed: number };
  assert.equal(newNote.notebookId, newChildId);
  assert.equal(newNote.isTrashed, 0);
});

test("explicit notebookId import rejects soft-deleted target notebooks", async () => {
  const first = await importOne(["Deleted Target"], "Before Delete");
  await deleteNotebook(first.notebookId);

  const res = await app.request("/export/import?workspaceId=personal", {
    method: "POST",
    headers: {
      "X-User-Id": USER_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      notebookId: first.notebookId,
      notes: [{
        title: "Should Fail",
        content: "{}",
        contentText: "Should Fail",
      }],
    }),
  });

  assert.equal(res.status, 400);
  const body = await res.json() as { code: string };
  assert.equal(body.code, "NOTEBOOK_TRASHED");
});

test("import preserves markdown contentFormat when provided", async () => {
  const res = await app.request("/export/import?workspaceId=personal", {
    method: "POST",
    headers: {
      "X-User-Id": USER_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      notes: [{
        title: "Markdown Import",
        content: "# Markdown Import\n\nBody",
        contentText: "Markdown Import Body",
        contentFormat: "markdown",
        notebookPath: ["SiYuan User Guide"],
      }],
    }),
  });
  if (res.status !== 201) {
    assert.equal(res.status, 201, await res.text());
  }
  const body = await res.json() as { notes: { id: string }[] };

  const row = db()
    .prepare("SELECT content, contentFormat FROM notes WHERE id = ?")
    .get(body.notes[0].id) as { content: string; contentFormat: string };
  assert.equal(row.contentFormat, "markdown");
  assert.equal(row.content, "# Markdown Import\n\nBody");
});

test("import extracts Markdown image data URIs into attachments", async () => {
  const res = await app.request("/export/import?workspaceId=personal", {
    method: "POST",
    headers: {
      "X-User-Id": USER_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      notes: [{
        title: "Markdown Image",
        content: "![pic](data:image/png;base64,iVBORw0KGgo=)",
        contentText: "pic",
        contentFormat: "markdown",
        notebookPath: ["SiYuan User Guide"],
      }],
    }),
  });
  if (res.status !== 201) {
    assert.equal(res.status, 201, await res.text());
  }
  const body = await res.json() as { notes: { id: string }[] };

  const row = db()
    .prepare("SELECT content, contentFormat FROM notes WHERE id = ?")
    .get(body.notes[0].id) as { content: string; contentFormat: string };
  assert.equal(row.contentFormat, "markdown");
  assert.match(row.content, /^!\[pic\]\(\/api\/attachments\/[a-f0-9-]+\)$/);

  const attachment = db()
    .prepare("SELECT noteId, mimeType, size FROM attachments WHERE noteId = ?")
    .get(body.notes[0].id) as { noteId: string; mimeType: string; size: number } | undefined;
  assert.ok(attachment);
  assert.equal(attachment.mimeType, "image/png");
  assert.ok(attachment.size > 0);
});
