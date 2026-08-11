import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { Hono } from "hono";
import * as Y from "yjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-format-yjs-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let db: any;
let closeDb: () => void;
let yJoin: (noteId: string, userId: string | null) => { stateBase64: string };
let yReplaceContentAsUpdate: (
  noteId: string,
  markdown: string,
  userId: string | null,
) => { updateBase64: string } | null;
let yDestroyDoc: (noteId: string) => void;

before(async () => {
  const schema = await import("../src/db/schema");
  // Importing the runtime installs the guarded parent route before /api/notes is mounted.
  await import("../src/runtime/note-format-yjs-transition");
  const yjs = await import("../src/services/yjs");

  db = schema.getDb();
  closeDb = schema.closeDb;
  yJoin = yjs.yJoin;
  yReplaceContentAsUpdate = yjs.yReplaceContentAsUpdate;
  yDestroyDoc = yjs.yDestroyDoc;

  db.exec(`
    INSERT INTO users (id, username, passwordHash)
    VALUES ('user-format', 'format-user', 'hash');

    INSERT INTO notebooks (id, userId, name, isDeleted)
    VALUES ('nb-format', 'user-format', 'Format notebook', 0);

    INSERT INTO notes (
      id, userId, notebookId, title, content, contentText, contentFormat
    ) VALUES (
      'note-format',
      'user-format',
      'nb-format',
      'Round trip',
      '# Original\n\n- one\n- two',
      'Original one two',
      'markdown'
    );
  `);
});

after(() => {
  try { yDestroyDoc?.("note-format"); } catch {}
  try { closeDb?.(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("MD -> RTE -> MD keeps stale IndexedDB structs deleted instead of duplicating the document", async () => {
  const noteId = "note-format";
  const originalMarkdown = "# Original\n\n- one\n- two";
  const targetMarkdown = "# Converted\n\n- alpha\n- beta";

  // First Markdown epoch: capture exactly what a browser IndexedDB cache would retain.
  const firstServerState = yJoin(noteId, "user-format");
  const staleBrowserDoc = new Y.Doc();
  Y.applyUpdate(staleBrowserDoc, new Uint8Array(Buffer.from(firstServerState.stateBase64, "base64")));
  assert.equal(staleBrowserDoc.getText("content").toString(), originalMarkdown);

  // The format conversion persists RTE JSON before calling release-room.
  db.prepare(`
    UPDATE notes
    SET content = ?, contentText = ?, contentFormat = 'tiptap-json', version = version + 1
    WHERE id = ?
  `).run(
    JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Converted" }] }],
    }),
    "Converted",
    noteId,
  );

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.req.raw.headers.set("X-User-Id", "user-format");
    await next();
  });
  const legacyNotesRouter = new Hono();
  legacyNotesRouter.post("/:id/yjs/release-room", (c) => c.json({ success: true, legacy: true }));
  app.route("/api/notes", legacyNotesRouter);

  const releaseResponse = await app.request(`/api/notes/${noteId}/yjs/release-room`, { method: "POST" });
  assert.equal(releaseResponse.status, 200);
  const releaseBody = await releaseResponse.json() as {
    success: boolean;
    legacy?: boolean;
    preservedCausalState?: boolean;
  };
  assert.equal(releaseBody.success, true);
  assert.equal(releaseBody.legacy, undefined, "guarded route must supersede the legacy destructive reset");
  assert.equal(releaseBody.preservedCausalState, true);

  // RTE -> Markdown: REST saves the new Markdown first, then syncToYjs seeds the next epoch.
  db.prepare(`
    UPDATE notes
    SET content = ?, contentText = ?, contentFormat = 'markdown', version = version + 1
    WHERE id = ?
  `).run(targetMarkdown, "Converted alpha beta", noteId);
  yReplaceContentAsUpdate(noteId, targetMarkdown, "user-format");

  // Reopening Markdown merges the new server state into the browser's old IndexedDB state.
  // The old implementation had deleted server history, so Yjs treated both bodies as unrelated
  // inserts and produced a doubled document. The tombstone snapshot makes the merge exact.
  const nextServerState = yJoin(noteId, "user-format");
  Y.applyUpdate(
    staleBrowserDoc,
    new Uint8Array(Buffer.from(nextServerState.stateBase64, "base64")),
  );

  assert.equal(staleBrowserDoc.getText("content").toString(), targetMarkdown);
  assert.equal(staleBrowserDoc.getText("content").toString().includes("Original"), false);
  staleBrowserDoc.destroy();
});
