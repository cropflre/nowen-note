import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-note-list-sort-order-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

test.before(async () => {
  const [notesModule, schemaModule] = await Promise.all([
    import("../src/routes/notes"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  app.route("/notes", notesModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("user-sort-order", "user-sort-order", "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name, sortOrder) VALUES (?, ?, ?, ?)")
    .run("notebook-sort-order", "user-sort-order", "Notebook", 0);
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, sortOrder)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "note-sort-order",
    "user-sort-order",
    "notebook-sort-order",
    "Note",
    "{}",
    "Note",
    7,
  );
});

test.after(async () => {
  closeDb();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (error?.code !== "EBUSY" || attempt === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

test("note list response includes the persisted manual sortOrder", async () => {
  const response = await app.request(
    "/notes?workspaceId=personal&notebookId=notebook-sort-order&sortBy=manual",
    { headers: { "X-User-Id": "user-sort-order" } },
  );

  assert.equal(response.status, 200);
  const notes = await response.json() as Array<{ id: string; sortOrder?: number }>;
  assert.equal(notes[0]?.id, "note-sort-order");
  assert.equal(notes[0]?.sortOrder, 7);
});
