import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import * as Y from "yjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-yjs-durable-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { getDb } from "../src/db/schema";
import { noteYupdatesRepository } from "../src/repositories/noteYupdatesRepository";
import { yDestroyDoc, yJoin } from "../src/services/yjs";
import { yApplyUpdateDurably } from "../src/services/yjsDurability";

const USER_ID = "user-yjs-durable";
const NOTEBOOK_ID = "notebook-yjs-durable";
const NOTE_ID = "note-yjs-durable";

function resetDb(content = "base") {
  try { yDestroyDoc(NOTE_ID); } catch {}
  const db = getDb();
  db.prepare("DELETE FROM note_versions").run();
  db.prepare("DELETE FROM note_yupdates").run();
  db.prepare("DELETE FROM note_ysnapshots").run();
  db.prepare("DELETE FROM notes").run();
  db.prepare("DELETE FROM notebooks").run();
  db.prepare("DELETE FROM users").run();

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(NOTEBOOK_ID, USER_ID, "Notebook");
  db.prepare(
    `INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(NOTE_ID, USER_ID, NOTEBOOK_ID, "Draft", content, content, "markdown");
}

function buildClientUpdate(nextText: string): string {
  const joined = yJoin(NOTE_ID, USER_ID);
  const client = new Y.Doc();
  Y.applyUpdate(client, new Uint8Array(Buffer.from(joined.stateBase64, "base64")));
  const before = Y.encodeStateVector(client);
  const text = client.getText("content");
  text.delete(0, text.length);
  text.insert(0, nextText);
  const update = Y.encodeStateAsUpdate(client, before);
  client.destroy();
  return Buffer.from(update).toString("base64");
}

function readServerText(): string {
  const joined = yJoin(NOTE_ID, USER_ID);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(joined.stateBase64, "base64")));
  const text = doc.getText("content").toString();
  doc.destroy();
  return text;
}

test("durable apply advances recovery log before success", async () => {
  resetDb();
  const update = buildClientUpdate("two days of recovered writing");
  const result = yApplyUpdateDurably(NOTE_ID, update, USER_ID);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.updateId > 0);
  assert.match(result.persistedAt, /^\d{4}-\d{2}-\d{2}T/);

  const rows = noteYupdatesRepository.listAfterId(NOTE_ID, 0);
  assert.equal(rows.length, 1);
  assert.equal(readServerText(), "two days of recovered writing");

  // The debounced recovery checkpoint makes Version History useful for Markdown.
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  const checkpoint = getDb().prepare(
    `SELECT content, changeSummary FROM note_versions
     WHERE "noteId" = ? ORDER BY "createdAt" DESC LIMIT 1`,
  ).get(NOTE_ID) as { content: string; changeSummary: string } | undefined;
  assert.ok(checkpoint);
  assert.equal(checkpoint?.content, "two days of recovered writing");
  assert.equal(checkpoint?.changeSummary, "Markdown collaborative autosave checkpoint");

  yDestroyDoc(NOTE_ID);
});

test("failed recovery-log insert never becomes a trusted server baseline", () => {
  resetDb("durable old body");
  const update = buildClientUpdate("unpersisted new body");
  const originalCreate = noteYupdatesRepository.create;
  (noteYupdatesRepository as any).create = () => {
    throw new Error("simulated disk failure");
  };

  try {
    const result = yApplyUpdateDurably(NOTE_ID, update, USER_ID);
    assert.deepEqual(result, { ok: false, code: "persist_failed" });
  } finally {
    (noteYupdatesRepository as any).create = originalCreate;
  }

  assert.equal(noteYupdatesRepository.listAfterId(NOTE_ID, 0).length, 0);
  // yApplyUpdate had already mutated memory, so the wrapper must destroy that room.
  // Rejoin must reconstruct only the last durable database state.
  assert.equal(readServerText(), "durable old body");

  yDestroyDoc(NOTE_ID);
});
