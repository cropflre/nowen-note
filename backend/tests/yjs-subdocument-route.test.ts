import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-y-subdocument-route-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.NOWEN_YJS_SUBDOCUMENTS = "1";

let closeDb: () => void;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("通过 ACL 提供章节清单、按需快照和原子章节更新", async () => {
  const [{ getDb, closeDb: close }, { default: notesRouter }, service] = await Promise.all([
    import("../src/db/schema"),
    import("../src/routes/notes"),
    import("../src/services/yjs-subdocuments"),
  ]);
  closeDb = close;
  const db = getDb();
  const ownerId = "subdocument-route-owner";
  const strangerId = "subdocument-route-stranger";
  const notebookId = "subdocument-route-book";
  const noteId = "17171717-1717-4717-8717-171717171717";
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')")
    .run(ownerId, ownerId);
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')")
    .run(strangerId, strangerId);
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, 'Subdocuments')")
    .run(notebookId, ownerId);
  const content = JSON.stringify({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1, blockId: "blk_route_a" }, content: [{ type: "text", text: "A" }] },
      { type: "paragraph", attrs: { blockId: "blk_route_a1" }, content: [{ type: "text", text: "one" }] },
      { type: "heading", attrs: { level: 1, blockId: "blk_route_b" }, content: [{ type: "text", text: "B" }] },
      { type: "paragraph", attrs: { blockId: "blk_route_b1" }, content: [{ type: "text", text: "two" }] },
    ],
  });
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version)
    VALUES (?, ?, ?, 'Subdocuments', ?, 'A one B two', 'tiptap-json', 1)
  `).run(noteId, ownerId, notebookId, content);

  const app = new Hono();
  app.route("/notes", notesRouter);

  const forbidden = await app.request(`/notes/${noteId}/yjs/subdocuments`, {
    headers: { "X-User-Id": strangerId },
  });
  assert.equal(forbidden.status, 403);

  const manifestResponse = await app.request(`/notes/${noteId}/yjs/subdocuments`, {
    headers: { "X-User-Id": ownerId },
  });
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json() as any;
  assert.equal(manifest.rootGuid, `nowen-root-${noteId}`);
  assert.deepEqual(manifest.sections.map((section: any) => section.id), [
    "section-blk_route_a",
    "section-blk_route_b",
  ]);
  assert.equal(manifest.sections[0].stateBase64, undefined, "清单不能预加载全部章节快照");

  const sectionId = manifest.sections[0].id as string;
  const stateResponse = await app.request(`/notes/${noteId}/yjs/subdocuments/${sectionId}`, {
    headers: { "X-User-Id": ownerId },
  });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json() as { guid: string; stateBase64: string };
  assert.match(state.stateBase64, /^[A-Za-z0-9+/]+=*$/);

  // 重读清单必须是纯读取；若这里重建 Y.Doc，刚下发的 state 会失去共同历史。
  const repeatedManifestResponse = await app.request(`/notes/${noteId}/yjs/subdocuments`, {
    headers: { "X-User-Id": ownerId },
  });
  assert.equal(repeatedManifestResponse.status, 200);
  assert.deepEqual(await repeatedManifestResponse.json(), manifest);

  const replacement = JSON.stringify({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1, blockId: "blk_route_a" }, content: [{ type: "text", text: "A" }] },
      { type: "paragraph", attrs: { blockId: "blk_route_a1" }, content: [{ type: "text", text: "updated" }] },
    ],
  });
  const update = service.createYjsSubdocumentContentUpdate(
    state.guid,
    new Uint8Array(Buffer.from(state.stateBase64, "base64")),
    replacement,
  );
  const updateResponse = await app.request(`/notes/${noteId}/yjs/subdocuments/${sectionId}`, {
    method: "POST",
    headers: { "X-User-Id": ownerId, "Content-Type": "application/json" },
    body: JSON.stringify({ updateBase64: Buffer.from(update).toString("base64") }),
  });
  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json() as any;
  assert.equal(updated.success, true);
  assert.equal(updated.version, 2);
  assert.match(updated.content, /updated/);
  assert.match((db.prepare("SELECT content FROM notes WHERE id = ?").get(noteId) as any).content, /updated/);
});

test("Subdocument 路由在功能关闭和非法更新时 fail closed", async () => {
  const [{ getDb }, { default: notesRouter }] = await Promise.all([
    import("../src/db/schema"),
    import("../src/routes/notes"),
  ]);
  const db = getDb();
  const noteId = "17171717-1717-4717-8717-171717171717";
  const ownerId = "subdocument-route-owner";
  const app = new Hono();
  app.route("/notes", notesRouter);

  const manifestResponse = await app.request(`/notes/${noteId}/yjs/subdocuments`, {
    headers: { "X-User-Id": ownerId },
  });
  const manifest = await manifestResponse.json() as any;
  const invalid = await app.request(`/notes/${noteId}/yjs/subdocuments/${manifest.sections[0].id}`, {
    method: "POST",
    headers: { "X-User-Id": ownerId, "Content-Type": "application/json" },
    body: JSON.stringify({ updateBase64: "not-base64" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as any).code, "INVALID_SUBDOCUMENT_UPDATE");

  process.env.NOWEN_YJS_SUBDOCUMENTS = "0";
  const disabled = await app.request(`/notes/${noteId}/yjs/subdocuments`, {
    headers: { "X-User-Id": ownerId },
  });
  assert.equal(disabled.status, 409);
  assert.equal((await disabled.json() as any).code, "SUBDOCUMENTS_DISABLED");
  process.env.NOWEN_YJS_SUBDOCUMENTS = "1";

  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM notes WHERE id = ?").get(noteId) as any).count, 1);
});
