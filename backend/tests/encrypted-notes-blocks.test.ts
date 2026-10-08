import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Hono } from "hono";
import { getDb, closeDb } from "../src/db/schema.js";
import { encryptedBlocksInContent, guardEncryptedNoteMutation } from "../src/lib/encryptedNotes.js";
import { extractSearchableText } from "../src/lib/searchIndex.js";
import { validateEncryptedRemoteNotes } from "../src/sync/applyLocal.js";
import { recordConflict } from "../src/sync/conflict.js";
import { applyMutation } from "../src/sync/apply.js";
const vector = JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), "utf8"));
// Structural test only: the backend cannot authenticate ciphertext.
const envelope = { ...vector.envelope, kind: "block" };
const source = JSON.stringify(envelope);
const fence = `\`\`\`nowen-encrypted-v1\n${source}\n\`\`\``;
const markdown = `Public before\n\n${fence}\n\nPublic after`;
const richDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Public before" }] }, { type: "codeBlock", attrs: { language: "nowen-encrypted-v1" }, content: [{ type: "text", text: source }] }] };
const rich = JSON.stringify(richDoc);
let app: Hono;
test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('block-owner', 'block-owner', 'hash')").run();
  db.prepare("INSERT INTO notebooks (id, name, userId) VALUES ('block-book', 'Public notebook', 'block-owner')").run();
  const { initAuditTables } = await import("../src/services/audit.js"); initAuditTables();
  const { default: router } = await import("../src/routes/notes.js");
  app = new Hono(); app.route("/notes", router);
});
test.after(() => closeDb());
async function request(path: string, body: any, method = "POST") {
  const response = await app.request(`/notes${path}`, { method, headers: { "X-User-Id": "block-owner", "Content-Type": "application/json" }, body: JSON.stringify({ encryptedBlocksVersion: 1, ...body }) });
  return { status: response.status, body: await response.json() as any };
}
test("mixed documents derive only public search text through the ordinary API", async () => {
  for (const [content, contentFormat] of [[markdown, "markdown"], [rich, "tiptap-json"]]) {
    const result = await request("", { notebookId: "block-book", title: "Public title", content, contentFormat });
    assert.equal(result.status, 201);
    assert.equal(encryptedBlocksInContent(result.body.content, contentFormat).length, 1);
    assert.ok(result.body.contentText.includes("Public before"));
    assert.ok(!result.body.contentText.includes(envelope.payload.ciphertext));
    const stored = getDb().prepare("SELECT content FROM notes WHERE id = ?").get(result.body.id) as any;
    assert.ok(!stored.content.includes(vector.plaintext)); assert.ok(!stored.content.includes(vector.passphrase));
  }
});
test("quotes, lists and tilde fences exclude ciphertext from public indexes", () => {
  for (const content of [fence, fence.replaceAll("```", "~~~"), fence.split("\n").map((line) => `> ${line}`).join("\n"), `- ${fence.replaceAll("\n", "\n  ")}`]) {
    assert.equal(encryptedBlocksInContent(content, "markdown").length, 1);
    assert.equal(extractSearchableText(content, "markdown"), "");
  }
  assert.equal(extractSearchableText(rich, "tiptap-json"), "Public before");
});
test("malformed blocks cannot overwrite an ordinary note via API or sync", async () => {
  const created = await request("", { notebookId: "block-book", title: "Public title", content: markdown, contentFormat: "markdown" });
  assert.equal(created.status, 201);
  const original = (getDb().prepare("SELECT content FROM notes WHERE id = ?").get(created.body.id) as any).content;
  let index = 0;
  for (const content of [fence.replace(source, "plaintext"), fence.replace("-v1", "-v9"), fence.replace(source, JSON.stringify(vector.envelope)), fence.slice(0, -3)]) {
    const result = await request(`/${created.body.id}`, { content, contentFormat: "markdown", version: created.body.version }, "PUT");
    assert.equal(result.status, 400); assert.equal(result.body.code, "INVALID_ENCRYPTED_NOTE");
    assert.throws(() => applyMutation(getDb(), { mutationId: `block-invalid-${index++}`, deviceId: "test-device", userId: "block-owner", entityType: "note", entityId: created.body.id, operation: "upsert", baseVersion: created.body.version, payload: { ...created.body, content, contentFormat: "markdown" } }), { code: "INVALID_ENCRYPTED_NOTE" });
  }
  for (const contentFormat of ["html", "tiptap-json"]) {
    const formatOnly = await request(`/${created.body.id}`, { contentFormat, version: created.body.version }, "PUT");
    assert.equal(formatOnly.status, 400); assert.equal(formatOnly.body.code, "INVALID_ENCRYPTED_NOTE");
  }
  const current = getDb().prepare("SELECT content FROM notes WHERE id = ?").get(created.body.id) as any;
  assert.equal(current.content, original);
});
test("conversion cannot change inner format or discard blocks into unsupported outer format", () => {
  assert.doesNotThrow(() => guardEncryptedNoteMutation({ content: rich, contentFormat: "tiptap-json" }, { content: markdown, contentFormat: "markdown" }));
  const changed = JSON.stringify({ ...envelope, originalFormat: "tiptap-json" });
  assert.throws(() => guardEncryptedNoteMutation({ content: JSON.stringify({ ...richDoc, content: [{ type: "codeBlock", attrs: { language: "nowen-encrypted-v1" }, content: [{ type: "text", text: changed }] }] }), contentFormat: "tiptap-json" }, { content: markdown, contentFormat: "markdown" }));
  assert.throws(() => guardEncryptedNoteMutation({ content: "<p>public</p>", contentFormat: "html" }, { content: markdown, contentFormat: "markdown" }));
});

test("legacy writers cannot erase regions through API, Push, Pull or remote conflicts", async () => {
  const created = await request("", { notebookId: "block-book", title: "Protected note", content: markdown, contentFormat: "markdown" });
  const note = (getDb().prepare("SELECT * FROM notes WHERE id = ?").get(created.body.id) as any);
  for (const encryptedBlocksVersion of [undefined, null, 0, 2, "1"]) {
    for (const content of ["public replacement", note.content]) {
      const result = await request(`/${note.id}`, { content, contentFormat: "markdown", version: note.version, encryptedBlocksVersion }, "PUT");
      assert.equal(result.status, 400); assert.equal(result.body.code, "INVALID_ENCRYPTED_NOTE");
    }
  }
  const partial = { id: note.id, title: "Old metadata upsert" };
  assert.throws(() => applyMutation(getDb(), { mutationId: "legacy-partial-push", deviceId: "test-device", userId: "block-owner", entityType: "note", entityId: note.id, operation: "upsert", baseVersion: note.version, payload: partial }));
  assert.throws(() => validateEncryptedRemoteNotes(getDb(), [{ entityType: "note", entityId: note.id, operation: "upsert", payload: partial }], { userId: "block-owner" }), { code: "INVALID_PAYLOAD" });
  const legacy = { ...note, content: "public replacement" };
  assert.throws(() => applyMutation(getDb(), { mutationId: "legacy-block-push", deviceId: "test-device", userId: "block-owner", entityType: "note", entityId: note.id, operation: "upsert", baseVersion: note.version, payload: legacy }));
  assert.throws(() => validateEncryptedRemoteNotes(getDb(), [{ entityType: "note", entityId: note.id, operation: "upsert", payload: legacy }], { userId: "block-owner" }), { code: "INVALID_PAYLOAD" });
  assert.throws(() => recordConflict(getDb(), { profileId: "test-profile", entityType: "note", entityId: note.id, localPayload: note, remotePayload: legacy }), { code: "INVALID_PAYLOAD" });
  assert.equal((getDb().prepare("SELECT content FROM notes WHERE id = ?").get(note.id) as any).content, note.content);
  const metadata = await request(`/${note.id}`, { isPinned: 1, encryptedBlocksVersion: undefined }, "PUT"); assert.equal(metadata.status, 200);
});
test("modern content writes require CAS and can deliberately remove a region", async () => {
  const created = await request("", { notebookId: "block-book", title: "Protected note", content: markdown, contentFormat: "markdown" });
  const note = created.body;
  const noVersion = await request(`/${note.id}`, { content: markdown, contentFormat: "markdown" }, "PUT"); assert.equal(noVersion.status, 400);
  const stale = await request(`/${note.id}`, { content: "deliberate public edit", contentFormat: "markdown", version: note.version + 5 }, "PUT"); assert.equal(stale.status, 409);
  const removed = await request(`/${note.id}`, { content: "deliberate public edit", contentFormat: "markdown", version: note.version }, "PUT"); assert.equal(removed.status, 200);
  assert.equal(encryptedBlocksInContent(removed.body.content, "markdown").length, 0);
  const history = getDb().prepare("SELECT content FROM note_versions WHERE noteId = ?").all(note.id) as any[];
  assert.ok(history.some((row) => encryptedBlocksInContent(row.content, "markdown").length === 1));
});
