import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { Hono } from "hono";
import { getDb, closeDb } from "../src/db/schema";

const owner = "decryption-owner";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const fixture = (version: number) => JSON.parse(fs.readFileSync(new URL(`../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v${version}.json`, import.meta.url), "utf8")).envelope;
let app: Hono;
test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  getDb().prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,'hash')").run(owner, owner);
  getDb().prepare("INSERT INTO notebooks(id,userId,name) VALUES ('decryption-notebook',?,'Notes')").run(owner);
  const { default: router } = await import("../src/routes/notes");
  app = new Hono(); app.route("/notes", router);
});
test.after(() => closeDb());

function create(version = 1, format = "markdown") {
  const id = randomUUID();
  const content = JSON.stringify({ ...fixture(version), objectId: id, originalFormat: format });
  getDb().prepare("INSERT INTO notes(id,userId,notebookId,title,content,contentFormat,contentText,version) VALUES (?,?,'decryption-notebook','Keep title',?,?,'',3)")
    .run(id, owner, content, `encrypted-note-v${version}`);
  const historyId = randomUUID();
  getDb().prepare("INSERT INTO note_versions(id,noteId,userId,content,contentFormat,contentText,version,changeType) VALUES (?,?,?,?,?,'',2,'edit')")
    .run(historyId, id, owner, content, `encrypted-note-v${version}`);
  const plaintext = format === "markdown" ? "# Permanent readable body" : JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Permanent readable body" }] }] });
  return { id, content, historyId, payload: {
    version: 3, sourceDigest: digest(content), content: plaintext, contentFormat: format, confirmPlaintext: true,
    decryptedHistory: [{ id: historyId, sourceDigest: digest(JSON.stringify([content, `encrypted-note-v${version}`, 2, null])), content: plaintext, contentFormat: format, changeSummary: null }],
  } };
}
const post = (id: string, payload: unknown, headers: Record<string, string> = {}) => app.request(`/notes/${id}/encryption/decrypt`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-User-Id": owner, ...headers }, body: JSON.stringify(payload),
});

for (const version of [1, 2]) for (const format of ["markdown", "tiptap-json"]) {
  test(`explicit owner decryption preserves v${version} ${format} identity and history (DCC-002)`, async () => {
    const { id, historyId, payload } = create(version, format);
    const response = await post(id, payload);
    assert.equal(response.status, 200, await response.clone().text());
    const saved = getDb().prepare("SELECT * FROM notes WHERE id=?").get(id) as any;
    assert.equal(saved.id, id); assert.equal(saved.notebookId, "decryption-notebook"); assert.equal(saved.title, "Keep title");
    assert.equal(saved.content, payload.content); assert.equal(saved.contentFormat, format); assert.equal(saved.version, 4);
    assert.match(saved.contentText, /Permanent readable body/);
    const history = getDb().prepare("SELECT * FROM note_versions WHERE id=?").get(historyId) as any;
    assert.equal(history.content, payload.content); assert.equal(history.contentFormat, format); assert.equal(history.version, 2);
    assert.equal((getDb().prepare("SELECT count(*) AS count FROM encrypted_note_decryption_permits").get() as any).count, 0);
    assert.equal((await post(id, payload)).status, 409);
  });
}

test("ordinary writes cannot downgrade ciphertext and failed conversion keeps all originals (DCC-004)", async () => {
  const { id, content, historyId, payload } = create();
  const patch = await app.request(`/notes/${id}`, { method: "PUT", headers: { "X-User-Id": owner, "Content-Type": "application/json" }, body: JSON.stringify({ version: 3, content: payload.content, contentFormat: "markdown" }) });
  assert.equal(patch.status, 400);
  assert.throws(() => getDb().prepare("UPDATE notes SET content='downgrade',contentFormat='markdown' WHERE id=?").run(id), /INVALID_ENCRYPTED_NOTE/);
  assert.equal((await post(id, { ...payload, decryptedHistory: [] })).status, 409);
  assert.equal((await post(id, { ...payload, version: 2 })).status, 409);
  assert.equal((await post(id, { ...payload, confirmPlaintext: false })).status, 400);
  assert.equal((await post(id, payload, { "X-User-Id": "other-owner" })).status, 403);
  assert.equal((await post(id, payload, { "X-Auth-Mode": "api-token" })).status, 403);
  assert.equal((getDb().prepare("SELECT content FROM notes WHERE id=?").get(id) as any).content, content);
  assert.equal((getDb().prepare("SELECT content FROM note_versions WHERE id=?").get(historyId) as any).content, content);
});

test("permanent decryption preserves note identity and favorites (DCC-002)", async () => {
  const { id, payload } = create();
  getDb().prepare("INSERT INTO favorites(userId,noteId) VALUES (?,?)").run(owner, id);
  const tagId = randomUUID();
  getDb().prepare("INSERT INTO tags(id,userId,name) VALUES (?,?,'Keep tag')").run(tagId, owner);
  getDb().prepare("INSERT INTO note_tags(noteId,tagId) VALUES (?,?)").run(id, tagId);
  const favorite = getDb().prepare("SELECT * FROM favorites WHERE noteId=?").get(id);
  const response = await post(id, payload);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(getDb().prepare("SELECT * FROM favorites WHERE noteId=?").get(id), favorite);
  const saved = await response.json() as any;
  assert.equal(saved.isFavorite, 1); assert.equal(saved.tags[0].id, tagId);
});

test("locked notes and servers with sync profiles refuse conversion without altering ciphertext", async () => {
  const { id, content, payload } = create();
  const source = await app.request(`/notes/${id}/encryption/decryption-source`, { headers: { "X-User-Id": owner } });
  assert.match(source.headers.get("cache-control") || "", /no-store/);
  getDb().prepare("UPDATE notes SET isLocked=1 WHERE id=?").run(id);
  assert.equal((await post(id, payload)).status, 409);
  getDb().prepare("UPDATE notes SET isLocked=0 WHERE id=?").run(id);
  getDb().prepare("INSERT INTO sync_profiles(id,name,serverUrl,enabled) VALUES ('decryption-profile','test','https://test.invalid',0)").run();
  try {
    const response = await post(id, payload);
    assert.equal(response.status, 409);
    assert.ok((await response.json() as any).blockers.includes("sync_conversion_not_supported"));
    assert.equal((getDb().prepare("SELECT content FROM notes WHERE id=?").get(id) as any).content, content);
  } finally { getDb().prepare("DELETE FROM sync_profiles WHERE id='decryption-profile'").run(); }
});

test("a history write failure rolls back plaintext, search projections and the temporary permit (DCC-004)", async () => {
  const { id, content, payload } = create();
  getDb().exec(`CREATE TRIGGER fail_decryption_history BEFORE INSERT ON note_versions
    WHEN NEW.noteId='${id}' AND NEW.contentFormat='markdown' BEGIN SELECT RAISE(ABORT,'test failure'); END`);
  try {
    assert.equal((await post(id, payload)).status, 500);
    assert.equal((getDb().prepare("SELECT content FROM notes WHERE id=?").get(id) as any).content, content);
    assert.equal((getDb().prepare("SELECT count(*) AS count FROM encrypted_note_decryption_permits").get() as any).count, 0);
    assert.equal((getDb().prepare("SELECT count(*) AS count FROM note_versions WHERE noteId=? AND contentFormat='markdown'").get(id) as any).count, 0);
    for (const table of ["notes_fts", "notes_search_fts"]) {
      assert.equal((getDb().prepare(`SELECT count(*) AS count FROM ${table} WHERE ${table} MATCH 'Permanent' AND rowid=(SELECT rowid FROM notes WHERE id=?)`).get(id) as any).count, 0);
    }
  } finally { getDb().exec("DROP TRIGGER fail_decryption_history"); }
});
