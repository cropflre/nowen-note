import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-txt-"));
process.env.DB_PATH = path.join(directory, "test.db");
process.env.ELECTRON_USER_DATA = directory;
const owner = "txt-owner";
const headers = { "Content-Type": "application/json", "X-User-Id": owner };
let app: Hono;
let db: any;
let closeDb: () => void;
test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  await import("../src/runtime/knowledge-tree.js");
  const schema = await import("../src/db/schema.js");
  db = schema.getDb(); closeDb = schema.closeDb;
  db.prepare("INSERT INTO users (id,username,passwordHash) VALUES (?,?,?)").run(owner, owner, "hash");
  db.prepare("INSERT INTO notebooks (id,userId,name) VALUES ('txt-book',?,'TXT')").run(owner);
  app = new Hono();
  app.route("/notes", (await import("../src/routes/notes.js")).default);
  app.route("/tree", (await import("../src/routes/knowledge-tree.js")).default);
});
test.after(() => { closeDb?.(); fs.rmSync(directory, { recursive: true, force: true }); });

test("TXT REST create, update and reopen retain literal content and searchable symbols", async () => {
  const sources = ["  # 标题\n**原文**\n- [ ] 未完成\n\n\t空白  \n", '{"type":"doc","content":[{"type":"text","text":"literal"}]}',
    '<script>alert(1)</script>\n<img src="blob:example">\n![image](file:///tmp/test)\n<img src="data:image/png;base64,aGVsbG8=">',
    "```nowen-encrypted-v1\n这是文字\n```\n^blk_user_literal"];
  for (const content of sources) {
    const response = await app.request("/notes", { method: "POST", headers, body: JSON.stringify({ notebookId: "txt-book", contentFormat: "plaintext", content, title: "TXT" }) });
    assert.equal(response.status, 201, await response.clone().text());
    const created = await response.json() as any;
    assert.equal(created.contentFormat, "plaintext"); assert.equal(created.content, content);
    assert.equal(db.prepare("SELECT contentText FROM notes WHERE id=?").get(created.id).contentText, content);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM note_blocks_index WHERE noteId=?").get(created.id).count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE noteId=?").get(created.id).count, 0);
    const next = `${content}\n新增文字  `;
    const updated = await app.request(`/notes/${created.id}`, { method: "PUT", headers, body: JSON.stringify({ content: next, version: created.version }) });
    assert.equal(updated.status, 200, await updated.clone().text());
    const reopened = await app.request(`/notes/${created.id}`, { headers });
    assert.equal((await reopened.json() as any).content, next);
  }
});

test("tree creates blank TXT documents at root and inside folders with existing permissions", async () => {
  const folderResponse = await app.request("/tree/nodes?workspaceId=personal", { method: "POST", headers, body: JSON.stringify({ parentId: null, nodeType: "folder", title: "Folder" }) });
  assert.equal(folderResponse.status, 201);
  const folder = await folderResponse.json() as any;
  for (const parentId of [null, folder.id]) {
    const response = await app.request("/tree/nodes?workspaceId=personal", { method: "POST", headers, body: JSON.stringify({ parentId, nodeType: "note", contentFormat: "plaintext", title: "TXT" }) });
    assert.equal(response.status, 201, await response.clone().text());
    const node = await response.json() as any;
    assert.equal(node.nodeType, "note"); assert.equal(node.contentFormat, "plaintext");
    const note = db.prepare("SELECT content,contentFormat FROM notes WHERE id=?").get(node.resourceId);
    assert.deepEqual(note, { content: "", contentFormat: "plaintext" });
  }
  db.prepare("INSERT INTO users (id,username,passwordHash) VALUES ('txt-other','txt-other','hash')").run();
  const denied = await app.request("/tree/nodes?workspaceId=personal", { method: "POST", headers: { ...headers, "X-User-Id": "txt-other" }, body: JSON.stringify({ parentId: folder.id, nodeType: "note", contentFormat: "plaintext", title: "Denied" }) });
  assert.equal(denied.status, 403);
});

test("Nowen backup export/import preserves TXT format and literal resource references", async () => {
  const { createNowenPackageExport } = await import("../src/services/nowenPackageExport.js");
  const { importNowenPackage } = await import("../src/services/nowenPackageImport.js");
  const content = '  [literal](/api/attachments/does-not-exist)\n[[literal-note-id]]\n<img src="data:image/png;base64,aGVsbG8=">\n  ';
  const response = await app.request("/notes", { method: "POST", headers, body: JSON.stringify({ notebookId: "txt-book", contentFormat: "plaintext", content, title: "TXT backup" }) });
  assert.equal(response.status, 201);
  const exported = await createNowenPackageExport({ userId: owner, workspaceId: null, notebookId: "txt-book", includeSubNotebooks: false, packageKind: "nowen" });
  const restored = await importNowenPackage(exported.buffer, { userId: owner, workspaceId: null, importMode: "new-root" });
  assert.equal(restored.success, true, restored.errors.join("; "));
  const notes = db.prepare("SELECT content,contentFormat FROM notes WHERE title='TXT backup'").all();
  assert.equal(notes.length, 2);
  for (const note of notes) assert.deepEqual(note, { content, contentFormat: "plaintext" });
});
