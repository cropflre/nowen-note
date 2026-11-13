import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-journal-trash-"));
process.env.DB_PATH = path.join(tempDir, "journal-trash.db");
let db: any;
let closeDb: () => void;
let journals: any;
let createKnowledgeChild: any;
let deleteKnowledgeNode: any;
const userId = "journal-trash-owner";
test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const schema = await import("../src/db/schema.js");
  db = schema.getDb(); closeDb = schema.closeDb;
  journals = (await import("../src/routes/journals.js")).default;
  ({ createKnowledgeChild, deleteKnowledgeNode } = await import("../src/services/knowledgeTree.js"));
  for (const id of [userId, "journal-trash-other"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(id, id);
  }
});
test.after(() => { closeDb(); fs.rmSync(tempDir, { recursive: true, force: true }); delete process.env.DB_PATH; });

function request(date: string, actor = userId, method = "POST") {
  return journals.request(new Request(`http://localhost${method === "GET" ? `/check?date=${date}` : "/today"}`, {
    method, headers: { "Content-Type": "application/json", "X-User-Id": actor },
    body: method === "POST" ? JSON.stringify({ localDate: date }) : undefined,
  }));
}
async function create(date: string) {
  const response = await request(date);
  assert.equal(response.status, 201);
  return await response.json() as any;
}
function trash(id: string) {
  deleteKnowledgeNode({ actorUserId: userId, nodeId: id, mode: "subtree", db });
}

test("DCC-007: opening a trashed journal restores its identity and content without duplicate dates", async () => {
  const date = "2026-08-10";
  const note = await create(date);
  const content = JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "keep this journal" }] }] });
  db.prepare("UPDATE notes SET title = 'Original title', content = ?, contentText = 'keep this journal', version = 9 WHERE id = ?").run(content, note.id);
  db.prepare("INSERT INTO note_versions (id, noteId, userId, content, version) VALUES ('journal-history', ?, ?, ?, 8)").run(note.id, userId, content);
  db.prepare("INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path) VALUES ('journal-attachment', ?, ?, 'keep.png', 'image/png', 4, 'keep.png')").run(note.id, userId);
  const related = () => [db.prepare("SELECT * FROM note_versions WHERE noteId = ?").all(note.id), db.prepare("SELECT * FROM attachments WHERE noteId = ?").all(note.id)];
  const originalRelated = related();
  for (let cycle = 0; cycle < 2; cycle++) {
    trash(`note:${note.id}`);
    const before = db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id) as any;
    assert.equal(before.isTrashed, 1);
    const check = await request(date, userId, "GET");
    assert.equal(check.status, 200);
    assert.deepEqual(await check.json(), { exists: false, noteId: null, title: null });
    assert.deepEqual(db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id), before);
    const responses = await Promise.all([request(date), request(date)]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      const restored = await response.json() as any;
      assert.equal(restored.id, note.id);
      assert.equal(restored.existed, true);
      assert.equal(restored.content, content);
      assert.equal(restored.title, "Original title");
      assert.equal(restored.isTrashed, 0);
      assert.equal(restored.trashedAt, null);
      assert.equal(restored.version, before.version + 1);
    }
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM notes WHERE userId = ? AND journal_date = ?").get(userId, date) as any).count, 1);
    assert.equal((db.prepare("SELECT isDeleted FROM knowledge_tree_nodes WHERE resourceId = ? AND resourceType = 'note'").get(note.id) as any).isDeleted, 0);
    assert.deepEqual(related(), originalRelated);
  }
});

test("DCC-007: restoring a journal under a deleted archive leaves unrelated siblings in trash", async () => {
  const note = await create("2026-08-11");
  const sibling = createKnowledgeChild({ actorUserId: userId, workspaceId: null, parentId: note.archive.monthNodeId, nodeType: "note", title: "Keep deleted", db });
  trash(note.archive.rootNodeId);
  assert.equal((db.prepare("SELECT isTrashed FROM notes WHERE id = ?").get(sibling.resourceId) as any).isTrashed, 1);
  const response = await request("2026-08-11");
  assert.equal(response.status, 200);
  const restored = await response.json() as any;
  assert.equal(restored.id, note.id);
  assert.equal((db.prepare("SELECT isTrashed FROM notes WHERE id = ?").get(sibling.resourceId) as any).isTrashed, 1);
  for (const id of [restored.archive.rootNotebookId, restored.archive.yearNotebookId, restored.archive.monthNotebookId]) {
    assert.equal((db.prepare("SELECT isDeleted FROM notebooks WHERE id = ?").get(id) as any).isDeleted, 0);
  }
});

test("DCC-006: journal restoration requires identity and keeps other accounts and workspace journals isolated", async () => {
  const date = "2026-08-12";
  const note = await create(date);
  trash(`note:${note.id}`);
  const before = db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id);
  assert.equal((await request(date, "")).status, 401);
  assert.equal((await request(date, "journal-trash-other")).status, 201);
  assert.deepEqual(db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id), before);
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES ('journal-team', 'Team', 'journal-trash-other')").run();
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('journal-team', ?, 'editor')").run(userId);
  db.prepare("UPDATE notes SET workspaceId = 'journal-team' WHERE id = ?").run(note.id);
  const { setKnowledgeNodeDenied } = await import("../src/services/knowledgeDenyPolicy.js");
  setKnowledgeNodeDenied({ actorUserId: "journal-trash-other", nodeId: `note:${note.id}`, targetUserId: userId, db });
  const deniedBefore = db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id);
  const denied = await request(date);
  assert.ok([403, 409].includes(denied.status));
  assert.deepEqual(db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id), deniedBefore);
});

test("DCC-002: restored journals capture durable Outbox intent and failed restoration rolls back all writes", async () => {
  const { createProfile, switchActiveProfile } = await import("../src/sync/profile.js");
  const { ensureDevice } = await import("../src/sync/device.js");
  const profile = createProfile(db, { name: "Journal sync", serverUrl: "https://journal-sync.test" });
  switchActiveProfile(db, profile.id);
  db.prepare("UPDATE sync_profiles SET bootstrapStatus = 'ready' WHERE id = ?").run(profile.id);
  ensureDevice(db, { profileId: profile.id, platform: "test" });
  const date = "2026-08-13";
  const note = await create(date);
  trash(`note:${note.id}`);
  const before = db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id) as any;
  const outboxCursor = (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS cursor FROM sync_outbox").get() as any).cursor;
  const restoreMutations = () => db.prepare("SELECT * FROM sync_outbox WHERE entityType = 'note' AND entityId = ? AND operation = 'upsert' AND rowid > ? ORDER BY rowid").all(note.id, outboxCursor) as any[];
  const response = await request(date);
  assert.equal(response.status, 200);
  const restored = await response.json() as any;
  const rows = restoreMutations();
  assert.ok(rows.some((row) => row.profileId === profile.id && row.baseVersion === before.version && JSON.parse(row.payload).isTrashed === 0));
  const finalPayload = JSON.parse(rows.at(-1).payload);
  assert.equal(finalPayload.content, before.content);
  assert.equal(finalPayload.version, before.version + 1);
  assert.equal(finalPayload.trashedAt, null);
  assert.equal(finalPayload.notebookId, restored.archive.monthNotebookId);
  closeDb();
  db = (await import("../src/db/schema.js")).getDb();
  assert.deepEqual(restoreMutations(), rows);
  assert.equal((db.prepare("SELECT version FROM notes WHERE id = ?").get(note.id) as any).version, before.version + 1);
  trash(note.archive.rootNodeId);
  const snapshot = () => ["notes", "notebooks", "knowledge_tree_nodes", "knowledge_tree_history", "sync_outbox"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const prior = snapshot();
  db.exec("CREATE TRIGGER journal_test_failure BEFORE INSERT ON knowledge_tree_history WHEN NEW.action = 'restore' BEGIN SELECT RAISE(ABORT, 'journal restore failure'); END");
  try {
    assert.equal((await request(date)).status, 500);
    assert.deepEqual(snapshot(), prior);
  } finally { db.exec("DROP TRIGGER journal_test_failure"); }
});

test("DCC-006: a password protected journal archive stays locked before and after deletion", async () => {
  const date = "2026-08-14";
  const note = await create(date);
  const knowledgeTree = (await import("../src/routes/knowledge-tree.js")).default;
  const response = await knowledgeTree.request(new Request(`http://localhost/nodes/${encodeURIComponent(note.archive.rootNodeId)}/password`, {
    method: "PUT", headers: { "Content-Type": "application/json", "X-User-Id": userId }, body: JSON.stringify({ newPassword: "journal-secret" }),
  }));
  assert.equal(response.status, 200);
  trash(`note:${note.id}`);
  for (const deletedRoot of [false, true]) {
    if (deletedRoot) trash(note.archive.rootNodeId);
    const before = db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id);
    const denied = await request(date);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as any).code, "FOLDER_UNLOCK_REQUIRED");
    assert.deepEqual(db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id), before);
  }
});
