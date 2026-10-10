import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-folder-sync-attachment-"));
const electronUserData = path.join(tmpDir, "electron-user-data");
process.env.ELECTRON_USER_DATA = electronUserData;
process.env.DB_PATH = path.join(electronUserData, "test.db");
delete process.env.NOWEN_DATA_DIR;

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

const USER_ID = "folder-sync-attachment-user";
const NOTEBOOK_ID = "folder-sync-attachment-notebook";

function sha(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

test.before(async () => {
  const [routeModule, schemaModule] = await Promise.all([
    import("../src/routes/folder-sync"),
    import("../src/db/schema"),
  ]);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  app = new Hono();
  app.route("/folder-sync", routeModule.default);

  getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
  getDb().prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(NOTEBOOK_ID, USER_ID, "Attachments");
});

test.after(() => {
  closeDb();
  delete process.env.ELECTRON_USER_DATA;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows can release handles later */ }
});

test("PDF imports are written below ELECTRON_USER_DATA instead of the packaged cwd", async () => {
  const bytes = Buffer.from("%PDF-1.4\n% folder sync path fixture\n", "utf8");
  const form = new FormData();
  form.append("file", new File([bytes], "manual.pdf", { type: "application/pdf" }));
  form.append("filename", "manual.pdf");
  form.append("relativePath", "docs/manual.pdf");
  form.append("sha256", sha(bytes));
  form.append("sourcePathHash", "f".repeat(64));
  form.append("targetNotebookId", NOTEBOOK_ID);
  form.append("conflictPolicy", "protect");
  form.append("extractText", "0");

  const response = await app.request("/folder-sync/import-attachment", {
    method: "POST",
    headers: { "X-User-Id": USER_ID },
    body: form,
  });
  assert.equal(response.status, 200, await response.text());

  const row = getDb().prepare("SELECT id, path, noteId FROM attachments WHERE uploadSource = 'folder_sync'").get() as {
    id: string;
    path: string;
    noteId: string;
  };
  assert.ok(row?.path);
  const absolutePath = path.join(electronUserData, "attachments", row.path);
  assert.equal(fs.existsSync(absolutePath), true);
  assert.equal(fs.readFileSync(absolutePath).equals(bytes), true);

  const note = getDb().prepare("SELECT content FROM notes WHERE id = ?").get(row.noteId) as { content: string };
  assert.match(note.content, new RegExp(`\\[📎 manual\\.pdf\\]\\(/api/attachments/${row.id}\\)`));
  const reference = getDb().prepare(`
    SELECT COUNT(*) AS count
      FROM attachment_references
     WHERE attachmentId = ? AND noteId = ?
  `).get(row.id, row.noteId) as { count: number };
  assert.equal(reference.count, 1);
});
