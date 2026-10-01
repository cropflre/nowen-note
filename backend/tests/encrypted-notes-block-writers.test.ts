import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { Hono } from "hono";
import * as Y from "yjs";
import { getDb, closeDb } from "../src/db/schema.js";
import { withEncryptedBlockWrite } from "../src/lib/encryptedBlockWrites.js";
import { getNoteBlocks } from "../src/lib/noteBlocks.js";
import { parseMarkdownPatchDocument } from "../src/lib/markdownBlockPatch.js";
import { normalizeSearchText } from "../src/lib/searchQuery.js";
import { encryptedBlocksMigration } from "../src/db/encryptedBlocksMigration.js";
import { encryptedBlocksInContent } from "../src/lib/encryptedNotes.js";
import { yJoin, yApplyUpdate, yDestroyDoc, yReplaceContentAsUpdate, yFlush } from "../src/services/yjs.js";
import { prepareYjsSubdocuments, getYjsSubdocumentSnapshot, createYjsSubdocumentContentUpdate, applyYjsSubdocumentUpdate, rebuildYjsSubdocumentsIfEnabled } from "../src/services/yjs-subdocuments.js";
const fixture = JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), "utf8"));
const source = JSON.stringify({ ...fixture.envelope, kind: "block" });
const fence = `\`\`\`nowen-encrypted-v1\n${source}\n\`\`\``;
const md = `Public before\n\n${fence}\n\nPublic after`;
const rt = JSON.stringify({ type: "doc", content: [
  { type: "paragraph", content: [{ type: "text", text: "Public before" }] },
  { type: "codeBlock", attrs: { language: "nowen-encrypted-v1" }, content: [{ type: "text", text: source }] },
  { type: "paragraph", content: [{ type: "text", text: "Public after" }] },
] });
let app: Hono;
test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js"); await import("../src/runtime/block-patch.js");
  getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES ('region-writer', 'region-writer', 'hash')").run();
  getDb().prepare("INSERT INTO notebooks (id, name, userId) VALUES ('region-writer-book', 'Public', 'region-writer')").run();
  const { initAuditTables } = await import("../src/services/audit.js"); initAuditTables();
  const { default: notes } = await import("../src/routes/notes.js"); const { default: blocks } = await import("../src/routes/blocks.js");
  app = new Hono(); app.route("/notes", notes); app.route("/api/blocks", blocks);
});
test.after(() => closeDb());
async function request(url: string, body: unknown, method = "POST") {
  return app.request(url, { method, headers: { "X-User-Id": "region-writer", "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function create(content = md, contentFormat = "markdown") {
  const response = await request("/notes", { notebookId: "region-writer-book", content, contentFormat, title: "Public", encryptedBlocksVersion: 1 });
  assert.equal(response.status, 201); return await response.json() as any;
}
function row(id: string) { return getDb().prepare("SELECT * FROM notes WHERE id = ?").get(id) as any; }
function noPermit(db = getDb()) { assert.equal((db.prepare("SELECT count(*) AS n FROM encrypted_block_write_permits").get() as any).n, 0); }

test("persistent SQLite guards reject unscoped changes after full database backup", async () => {
  const note = await create(); const original = row(note.id);
  for (const sql of ["UPDATE notes SET content = 'old replacement' WHERE id = ?", "UPDATE notes SET contentFormat = 'html' WHERE id = ?", "UPDATE notes SET content = replace(content, 'Public before', 'old public edit') WHERE id = ?"]) assert.throws(() => getDb().prepare(sql).run(note.id), /ENCRYPTED_BLOCK_WRITE_FORBIDDEN/);
  getDb().prepare("UPDATE notes SET isPinned = 1 WHERE id = ?").run(note.id); assert.equal(row(note.id).content, original.content); noPermit();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-region-guard-")); let restored: Database.Database | undefined;
  try {
    await getDb().backup(path.join(directory, "backup.db")); restored = new Database(path.join(directory, "backup.db"));
    restored.function("nowen_search_normalize", { deterministic: true }, (value: unknown) => normalizeSearchText(String(value ?? "")));
    assert.throws(() => restored!.prepare("UPDATE notes SET content = 'old replacement' WHERE id = ?").run(note.id), /ENCRYPTED_BLOCK_WRITE_FORBIDDEN/);
    restored.prepare("UPDATE notes SET isPinned = 0 WHERE id = ?").run(note.id);
    assert.equal((restored.prepare("SELECT content FROM notes WHERE id = ?").get(note.id) as any).content, original.content); noPermit(restored);
  } finally { restored?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("standalone SQLite migration survives backup without application functions", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-region-migration-"));
  const db = new Database(":memory:"); let restored: Database.Database | undefined;
  try {
    db.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, content TEXT, contentFormat TEXT, isPinned INTEGER DEFAULT 0)");
    encryptedBlocksMigration.up(db);
    db.prepare("INSERT INTO notes (id, content, contentFormat) VALUES (?, ?, 'markdown')").run("protected", md);
    await db.backup(path.join(directory, "backup.db")); restored = new Database(path.join(directory, "backup.db"));
    assert.throws(() => restored!.prepare("UPDATE notes SET content = 'old replacement' WHERE id = 'protected'").run(), /ENCRYPTED_BLOCK_WRITE_FORBIDDEN/);
    assert.throws(() => restored!.prepare("UPDATE notes SET contentFormat = 'html' WHERE id = 'protected'").run(), /ENCRYPTED_BLOCK_WRITE_FORBIDDEN/);
    restored.prepare("UPDATE notes SET isPinned = 1 WHERE id = 'protected'").run();
    assert.equal((restored.prepare("SELECT content, isPinned FROM notes WHERE id = 'protected'").get() as any).content, md);
    assert.equal((restored.prepare("SELECT isPinned FROM notes WHERE id = 'protected'").get() as any).isPinned, 1);
    noPermit(restored);
  } finally { restored?.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("exact transactional permits cannot target another note, leak on failure or discard envelopes", async () => {
  const note = await create(); const other = await create(); const original = row(note.id).content; const changed = original.replace("Public before", "Public edited");
  assert.throws(() => withEncryptedBlockWrite(getDb(), note.id, changed, "markdown", () => getDb().prepare("UPDATE notes SET content = 'different target' WHERE id = ?").run(note.id)), /ENCRYPTED_BLOCK_WRITE_FORBIDDEN/);
  assert.throws(() => withEncryptedBlockWrite(getDb(), note.id, changed, "markdown", () => getDb().prepare("UPDATE notes SET content = ? WHERE id = ?").run(changed, other.id)), /ENCRYPTED_BLOCK_WRITE_FORBIDDEN/);
  assert.throws(() => withEncryptedBlockWrite(getDb(), note.id, "removed", "markdown", () => assert.fail("must not write")), { code: "INVALID_ENCRYPTED_NOTE" });
  assert.throws(() => withEncryptedBlockWrite(getDb(), note.id, changed, "markdown", () => { getDb().prepare("UPDATE notes SET content = ? WHERE id = ?").run(changed, note.id); throw new Error("rollback"); }), /rollback/);
  assert.equal(row(note.id).content, original); noPermit();
  withEncryptedBlockWrite(getDb(), note.id, changed, "markdown", () => getDb().prepare("UPDATE notes SET content = ? WHERE id = ?").run(changed, note.id)); assert.equal(row(note.id).content, changed); noPermit();
  withEncryptedBlockWrite(getDb(), note.id, "deliberate deletion", "markdown", () => getDb().prepare("UPDATE notes SET content = ? WHERE id = ?").run("deliberate deletion", note.id), 1); assert.equal(row(note.id).content, "deliberate deletion"); noPermit();
});

for (const format of ["markdown", "tiptap-json"]) {
  test(`${format} batch patches edit public blocks and reject region/copy loss atomically`, async () => {
    const content = format === "markdown" ? `${md}\n\n${fence}` : JSON.stringify({ ...JSON.parse(rt), content: [...JSON.parse(rt).content, JSON.parse(rt).content[1]] });
    const note = await create(content, format); const blocks = getNoteBlocks(getDb(), note.id, 1000);
    const region = blocks.find((block) => block.blockType === "codeBlock")!; const publicBlock = blocks.find((block) => block.blockType === "paragraph")!;
    assert.ok(region); assert.ok(publicBlock);
    const markdownBlocks = format === "markdown" ? parseMarkdownPatchDocument(row(note.id).content).blocks : [];
    const publicHash = markdownBlocks.find((block) => block.blockId === publicBlock.blockId)?.contentHash;
    const operations = format === "markdown"
      ? [{ type: "replace", blockId: publicBlock.blockId, expectedHash: publicHash, content: `Public changed ^${publicBlock.blockId}` }]
      : [{ type: "update", blockId: publicBlock.blockId, text: "Public changed" }];
    const success = await request(`/api/blocks/${note.id}/patch`, { expectedNoteVersion: note.version, operationId: `region-public-${format}`, operations });
    assert.equal(success.status, 200, await success.clone().text());
    const current = row(note.id); assert.ok(current.content.includes("Public changed"));
    assert.deepEqual(encryptedBlocksInContent(current.content, format).map((block) => block.serialized), [source, source]);
    const regionHash = markdownBlocks.find((block) => block.blockId === region.blockId)?.contentHash;
    const retryOperations = format === "markdown"
      ? [{ ...operations[0], content: `Public must roll back ^${publicBlock.blockId}`, expectedHash: parseMarkdownPatchDocument(current.content).blocks.find((block) => block.blockId === publicBlock.blockId)!.contentHash }]
      : [{ type: "update", blockId: publicBlock.blockId, text: "Public must roll back" }];
    const history = getDb().prepare("SELECT * FROM note_versions WHERE noteId = ?").all(note.id); const receipts = getDb().prepare("SELECT * FROM block_operations WHERE noteId = ?").all(note.id);
    const indexedBlocks = getNoteBlocks(getDb(), note.id, 1000); let n = 0;
    for (const operation of [format === "markdown" ? { type: "delete", blockId: region.blockId, expectedHash: regionHash } : { type: "delete", blockId: region.blockId }, format === "markdown" ? { type: "replace", blockId: region.blockId, expectedHash: regionHash, content: `old replacement ^${region.blockId}` } : { type: "update", blockId: region.blockId, text: "old replacement" }]) {
      const rejected = await request(`/api/blocks/${note.id}/patch`, { expectedNoteVersion: current.version, operationId: `region-reject-${format}-${n++}`, operations: [...retryOperations, operation] });
      assert.equal(rejected.status, 400); assert.equal((await rejected.json() as any).code, "INVALID_ENCRYPTED_NOTE"); assert.equal(row(note.id).content, current.content); assert.equal(row(note.id).version, current.version);
      assert.deepEqual(getDb().prepare("SELECT * FROM note_versions WHERE noteId = ?").all(note.id), history); assert.deepEqual(getDb().prepare("SELECT * FROM block_operations WHERE noteId = ?").all(note.id), receipts); noPermit();
      assert.deepEqual(getNoteBlocks(getDb(), note.id, 1000), indexedBlocks);
    }
    const legacy = await request(`/api/blocks/${note.id}/${region.blockId}`, { expectedNoteVersion: current.version, operationId: `region-legacy-${format}` }, "DELETE"); assert.equal(legacy.status, 400); assert.equal(row(note.id).content, current.content); noPermit();
  });
}

test("Yjs refuses protected joins and stale rooms before applying or persisting updates", async () => {
  const protectedNote = await create(); assert.throws(() => yJoin(protectedNote.id, "region-writer"), /COLLABORATION_FORBIDDEN/); assert.throws(() => yReplaceContentAsUpdate(protectedNote.id, "old replacement", "region-writer"), /COLLABORATION_FORBIDDEN/);
  const note = await create("Public ordinary"); const state = yJoin(note.id, "region-writer"); const client = new Y.Doc(); Y.applyUpdate(client, Buffer.from(state.stateBase64, "base64"));
  const baseline = Y.encodeStateVector(client); client.getText("content").insert(0, "new live prefix "); const update = Buffer.from(Y.encodeStateAsUpdate(client, baseline)).toString("base64");
  const changed = await request(`/notes/${note.id}`, { content: md, contentFormat: "markdown", version: note.version, encryptedBlocksVersion: 1 }, "PUT"); assert.equal(changed.status, 200);
  const before = getDb().prepare("SELECT * FROM note_yupdates WHERE noteId = ?").all(note.id);
  assert.equal(yApplyUpdate(note.id, update, "region-writer"), "invalid"); assert.deepEqual(getDb().prepare("SELECT * FROM note_yupdates WHERE noteId = ?").all(note.id), before);
  yFlush(note.id); assert.ok(row(note.id).content.includes(source)); client.destroy(); yDestroyDoc(note.id);
});

test("ordinary Yjs rooms and subdocuments cannot introduce encrypted regions", async () => {
  const note = await create("Public ordinary"); const joined = yJoin(note.id, "region-writer"); const client = new Y.Doc(); Y.applyUpdate(client, Buffer.from(joined.stateBase64, "base64"));
  const originalRoomContent = client.getText("content").toString();
  const before = Y.encodeStateVector(client); client.getText("content").insert(0, fence);
  const updatesBefore = getDb().prepare("SELECT * FROM note_yupdates WHERE noteId = ?").all(note.id);
  assert.equal(yApplyUpdate(note.id, Buffer.from(Y.encodeStateAsUpdate(client, before)).toString("base64"), "region-writer"), "invalid"); assert.ok(row(note.id).content.includes("Public ordinary"));
  assert.deepEqual(getDb().prepare("SELECT * FROM note_yupdates WHERE noteId = ?").all(note.id), updatesBefore);
  const observer = new Y.Doc();
  Y.applyUpdate(observer, Buffer.from(yJoin(note.id, "region-writer").stateBase64, "base64"));
  assert.equal(observer.getText("content").toString(), originalRoomContent);
  observer.destroy(); client.destroy(); yDestroyDoc(note.id);
  const rich = await create(JSON.stringify({ type: "doc", content: [{ type: "paragraph", attrs: { blockId: "blk_region_yjs" }, content: [{ type: "text", text: "Public" }] }] }), "tiptap-json"); const manifest = prepareYjsSubdocuments(getDb(), rich.id, rich.content);
  const section = getYjsSubdocumentSnapshot(getDb(), rich.id, manifest.sections[0].id)!;
  const update = createYjsSubdocumentContentUpdate(section.guid, section.snapshot, rt);
  assert.throws(() => applyYjsSubdocumentUpdate(getDb(), rich.id, manifest.sections[0].id, update, "region-writer", manifest.generation), /COLLABORATION_FORBIDDEN/); assert.equal(row(rich.id).content, rich.content);
  assert.deepEqual(getYjsSubdocumentSnapshot(getDb(), rich.id, manifest.sections[0].id), section);
  const protectedRich = await create(rt, "tiptap-json"); assert.throws(() => prepareYjsSubdocuments(getDb(), protectedRich.id, protectedRich.content), /COLLABORATION_FORBIDDEN/);
  const previous = process.env.NOWEN_YJS_SUBDOCUMENTS; process.env.NOWEN_YJS_SUBDOCUMENTS = "1";
  try { assert.equal(rebuildYjsSubdocumentsIfEnabled(getDb(), protectedRich.id, protectedRich.content, "tiptap-json"), false); }
  finally { if (previous === undefined) delete process.env.NOWEN_YJS_SUBDOCUMENTS; else process.env.NOWEN_YJS_SUBDOCUMENTS = previous; }
});
