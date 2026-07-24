import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-block-authority-recovery-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let closeDb: () => void;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("recovery synchronizes healthy notes and preserves invalid note snapshots", async () => {
  const [{ getDb, closeDb: close }, store, noteBlocks, recovery] = await Promise.all([
    import("../src/db/schema"),
    import("../src/lib/blockAuthorityStore"),
    import("../src/lib/noteBlocks"),
    import("../src/services/blockAuthorityRecovery"),
  ]);
  closeDb = close;
  const db = getDb();
  const userId = "recovery-user";
  const notebookId = "recovery-notebook";
  const healthyId = "35353535-3535-4535-8535-353535353535";
  const invalidId = "36363636-3636-4636-8636-363636363636";
  const healthyContent = JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "恢复成功" }] }],
  });
  const initialInvalidContent = JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "旧快照" }] }],
  });
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(userId, userId, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(notebookId, userId, "恢复测试");
  const insert = db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version)
    VALUES (?, ?, ?, ?, ?, '', 'tiptap-json', 1)
  `);
  insert.run(healthyId, userId, notebookId, "健康", healthyContent);
  insert.run(invalidId, userId, notebookId, "损坏", initialInvalidContent);

  const initialSync = noteBlocks.syncNoteBlocks(db, invalidId, initialInvalidContent, "tiptap-json");
  store.rebuildBlockAuthorityStore(db, invalidId, initialSync.content, "tiptap-json", {
    noteVersion: 1,
    operationType: "snapshot",
  });
  const invalidContent = "{not-json";
  db.prepare("UPDATE notes SET content = ? WHERE id = ?").run(invalidContent, invalidId);

  const result = recovery.synchronizeRecoveredBlockAuthority(db, [healthyId, invalidId, healthyId, "missing"]);

  assert.equal(result.synchronized, 1);
  assert.deepEqual(result.skipped, ["missing"]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.noteId, invalidId);
  assert.equal((db.prepare("SELECT status FROM note_block_documents WHERE noteId = ?").get(healthyId) as any).status, "healthy");
  const persistedHealthyContent = (db.prepare("SELECT content FROM notes WHERE id = ?").get(healthyId) as any).content;
  assert.notEqual(persistedHealthyContent, healthyContent, "恢复时补齐的 Block ID 必须写回 notes.content");
  assert.deepEqual(
    store.readAuthoritativeNoteContent(db, healthyId, persistedHealthyContent),
    { content: persistedHealthyContent, source: "blocks", status: "healthy" },
  );
  assert.equal((db.prepare("SELECT status FROM note_block_documents WHERE noteId = ?").get(invalidId) as any).status, "mismatch");
  assert.equal((db.prepare("SELECT content FROM notes WHERE id = ?").get(invalidId) as any).content, invalidContent);
  assert.equal(
    (db.prepare("SELECT operationType FROM note_block_operations WHERE noteId = ? ORDER BY createdAt DESC LIMIT 1")
      .get(healthyId) as any).operationType,
    "recovery-sync",
  );
});
