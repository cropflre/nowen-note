import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-note-format-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
let noteVersionsRepository: typeof import("../src/repositories/noteVersionsRepository").noteVersionsRepository;

const USER_ID = "user-format";
const NOTEBOOK_ID = "nb-format";
const NOTE_ID = "note-format";
const SHARE_TOKEN = "share-format-token";

function db() {
  return getDb();
}

function seedBase() {
  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
  db().prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(NOTEBOOK_ID, USER_ID, "NB");
}

function seedNote(contentFormat = "tiptap-json") {
  db().prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(NOTE_ID, USER_ID, NOTEBOOK_ID, "Original", "{}", "Original", contentFormat, 1);
}

function seedEditableShare() {
  db().prepare(`
    INSERT INTO shares (id, noteId, ownerId, shareToken, permission, isActive)
    VALUES (?, ?, ?, ?, 'edit', 1)
  `).run("share-format", NOTE_ID, USER_ID, SHARE_TOKEN);
}

function resetData() {
  db().prepare("DELETE FROM note_versions").run();
  db().prepare("DELETE FROM shares").run();
  db().prepare("DELETE FROM notes").run();
  db().prepare("DELETE FROM notebooks").run();
  seedBase();
}

async function requestJson(method: string, url: string, body?: unknown, userId = USER_ID) {
  const res = await app.request(url, {
    method,
    headers: {
      "X-User-Id": userId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test.before(async () => {
  const [notesModule, sharesModule, schemaModule, versionsModule] = await Promise.all([
    import("../src/routes/notes"),
    import("../src/routes/shares"),
    import("../src/db/schema"),
    import("../src/repositories/noteVersionsRepository"),
  ]);
  app = new Hono();
  app.route("/notes", notesModule.default);
  app.route("/shares", sharesModule.sharesRouter);
  app.route("/shared", sharesModule.sharedRouter);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  noteVersionsRepository = versionsModule.noteVersionsRepository;
  seedBase();
});

test.beforeEach(() => {
  resetData();
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

test("notes.put requires version when contentFormat changes", async () => {
  seedNote();

  const res = await requestJson("PUT", `/notes/${NOTE_ID}`, { contentFormat: "markdown" });

  assert.equal(res.status, 400);
  assert.equal(res.json.code, "VERSION_REQUIRED");
});

test("notes.put rejects stale version when contentFormat changes", async () => {
  seedNote();
  db().prepare("UPDATE notes SET version = 2 WHERE id = ?").run(NOTE_ID);

  const res = await requestJson("PUT", `/notes/${NOTE_ID}`, { contentFormat: "markdown", version: 1 });

  assert.equal(res.status, 409);
  assert.equal(res.json.code, "VERSION_CONFLICT");
  assert.equal(res.json.currentVersion, 2);
});

test("notes.put contentFormat change creates a version snapshot with previous format", async () => {
  seedNote("tiptap-json");

  const res = await requestJson("PUT", `/notes/${NOTE_ID}`, { contentFormat: "markdown", version: 1 });

  assert.equal(res.status, 200);
  const version = db().prepare("SELECT contentFormat FROM note_versions WHERE noteId = ?").get(NOTE_ID) as any;
  assert.ok(version);
  assert.equal(version.contentFormat, "tiptap-json");
});

test("restoring a markdown version restores contentFormat and returns it", async () => {
  seedNote("tiptap-json");
  await noteVersionsRepository.createAsync({
    id: "version-markdown",
    noteId: NOTE_ID,
    userId: USER_ID,
    title: "Markdown title",
    content: "# Markdown title",
    contentText: "Markdown title",
    contentFormat: "markdown",
    version: 1,
    changeType: "edit",
  });

  const versionRes = await requestJson("GET", `/shares/note/${NOTE_ID}/versions/version-markdown`);
  assert.equal(versionRes.status, 200);
  assert.equal(versionRes.json.contentFormat, "markdown");

  const restoreRes = await requestJson("POST", `/shares/note/${NOTE_ID}/versions/version-markdown/restore`);

  assert.equal(restoreRes.status, 200);
  assert.equal(restoreRes.json.contentFormat, "markdown");
  const row = db().prepare("SELECT title, content, contentText, contentFormat, version FROM notes WHERE id = ?").get(NOTE_ID) as any;
  assert.equal(row.title, "Markdown title");
  assert.equal(
    row.content.replace(/\s+\^blk_[A-Za-z0-9_-]+(?=\n|$)/g, ""),
    "# Markdown title",
  );
  assert.equal(row.contentText, "Markdown title");
  assert.equal(row.contentFormat, "markdown");
  assert.equal(row.version, 2);
});

test("restore creates a reversible snapshot of the current content", async () => {
  seedNote("markdown");
  db().prepare(`
    UPDATE notes
    SET title = ?, content = ?, contentText = ?, contentFormat = ?, version = ?
    WHERE id = ?
  `).run("Content B", "## B\n\ncurrent", "B current", "markdown", 2, NOTE_ID);
  await noteVersionsRepository.createAsync({
    id: "version-a",
    noteId: NOTE_ID,
    userId: USER_ID,
    title: "Content A",
    content: "# A\n\nold",
    contentText: "A old",
    contentFormat: "markdown",
    version: 1,
    changeType: "edit",
  });

  const restoreA = await requestJson("POST", `/shares/note/${NOTE_ID}/versions/version-a/restore`);

  assert.equal(restoreA.status, 200);
  assert.equal(restoreA.json.title, "Content A");
  assert.equal(restoreA.json.contentFormat, "markdown");
  const restoreSnapshot = db().prepare(`
    SELECT id, title, content, contentText, contentFormat, version, changeType, changeSummary
    FROM note_versions
    WHERE noteId = ? AND changeType = 'restore'
  `).get(NOTE_ID) as any;
  assert.ok(restoreSnapshot);
  assert.equal(restoreSnapshot.title, "Content B");
  assert.equal(restoreSnapshot.content, "## B\n\ncurrent");
  assert.equal(restoreSnapshot.contentText, "B current");
  assert.equal(restoreSnapshot.contentFormat, "markdown");
  assert.equal(restoreSnapshot.version, 2);
  assert.equal(restoreSnapshot.changeSummary, "恢复前自动备份");

  const restoreB = await requestJson("POST", `/shares/note/${NOTE_ID}/versions/${restoreSnapshot.id}/restore`);

  assert.equal(restoreB.status, 200);
  assert.equal(restoreB.json.title, "Content B");
  assert.equal(
    restoreB.json.content.replace(/\s+\^blk_[A-Za-z0-9_-]+(?=\n|$)/g, ""),
    "## B\n\ncurrent",
  );
  assert.equal(
    restoreB.json.contentText.replace(/\s+/g, " ").trim(),
    "B current",
  );
  assert.equal(restoreB.json.contentFormat, "markdown");
  assert.equal(restoreB.json.version, 4);
});

test("restoring a rich text version keeps tiptap-json contentFormat", async () => {
  seedNote("markdown");
  const richTextContent = JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Rich text" }] }],
  });
  await noteVersionsRepository.createAsync({
    id: "version-rich-text",
    noteId: NOTE_ID,
    userId: USER_ID,
    title: "Rich text title",
    content: richTextContent,
    contentText: "Rich text",
    contentFormat: "tiptap-json",
    version: 1,
    changeType: "edit",
  });

  const restoreRes = await requestJson("POST", `/shares/note/${NOTE_ID}/versions/version-rich-text/restore`);

  assert.equal(restoreRes.status, 200);
  assert.equal(restoreRes.json.contentFormat, "tiptap-json");
  const row = db().prepare("SELECT title, content, contentText, contentFormat, version FROM notes WHERE id = ?").get(NOTE_ID) as any;
  assert.equal(row.title, "Rich text title");
  const restoredDoc = JSON.parse(row.content);
  assert.equal(restoredDoc.type, "doc");
  assert.equal(restoredDoc.content?.[0]?.type, "paragraph");
  assert.equal(restoredDoc.content?.[0]?.content?.[0]?.text, "Rich text");
  assert.match(String(restoredDoc.content?.[0]?.attrs?.blockId || ""), /^blk_/);
  assert.equal(row.contentText, "Rich text");
  assert.equal(row.contentFormat, "tiptap-json");
  assert.equal(row.version, 2);
});

test("shared content update requires version", async () => {
  seedNote();
  seedEditableShare();

  const res = await requestJson("PUT", `/shared/${SHARE_TOKEN}/content`, {
    guestName: "Guest",
    content: "changed",
    contentText: "changed",
  });

  assert.equal(res.status, 400);
  assert.equal(res.json.code, "VERSION_REQUIRED");
});

test("shared content update rejects stale version", async () => {
  seedNote();
  seedEditableShare();
  db().prepare("UPDATE notes SET version = 2 WHERE id = ?").run(NOTE_ID);

  const res = await requestJson("PUT", `/shared/${SHARE_TOKEN}/content`, {
    guestName: "Guest",
    content: "changed",
    contentText: "changed",
    version: 1,
  });

  assert.equal(res.status, 409);
  assert.equal(res.json.code, "VERSION_CONFLICT");
  assert.equal(res.json.currentVersion, 2);
});
