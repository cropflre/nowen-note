import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-folder-hierarchy-"));
process.env.DB_PATH = path.join(tmp, "hierarchy.db");
process.env.NOWEN_DATA_DIR = path.join(tmp, "data");

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
const USER = "folder-hierarchy-user";
const ROOT = "folder-hierarchy-root";
const FOLDER_ID = "root-source-abcdef";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
function db() { return getDb(); }
async function post(endpoint: string, payload: object) {
  const r = await app.request("/folder-sync/" + endpoint, {
    method: "POST", headers: { "X-User-Id": USER, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json() as any };
}
function payload(relativePath: string, contents: string, sourceHash = sha(relativePath), nested = true) {
  return {
    filename: relativePath.split("/").pop(), relativePath,
    sha256: sha(contents), sourcePathHash: sourceHash,
    targetNotebookId: ROOT, contentText: contents,
    conflictPolicy: "protect", preserveHierarchy: nested, sourceFolderId: FOLDER_ID,
  };
}
function note(noteId: string): { notebookId: string; content: string; title: string; version: number } {
  return db().prepare("SELECT notebookId, content, title, version FROM notes WHERE id = ?").get(noteId) as any;
}
function notebook(notebookId: string): { parentId: string; name: string } {
  return db().prepare("SELECT parentId, name FROM notebooks WHERE id = ?").get(notebookId) as any;
}
test.before(async () => {
  const [route, schema] = await Promise.all([import("../src/routes/folder-sync"), import("../src/db/schema")]);
  getDb = schema.getDb; closeDb = schema.closeDb;
  app = new Hono(); app.route("/folder-sync", route.default);
  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER, USER, "test");
  db().prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(ROOT, USER, "Source files");
});
test.after(() => { closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("nested paths create an exact notebook tree and preserve distinct same-name leaf folders", async () => {
  const a = await post("import-file", payload("guides/frontend/readme.md", "frontend contents"));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await post("import-file", payload("guides/backend/readme.md", "backend contents"));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const frontFolder = note(a.body.noteId).notebookId;
  const backendFolder = note(b.body.noteId).notebookId;
  assert.notEqual(frontFolder, backendFolder);
  assert.equal(notebook(frontFolder).name, "frontend");
  assert.equal(notebook(backendFolder).name, "backend");
  assert.equal(notebook(frontFolder).parentId, notebook(backendFolder).parentId);
  assert.equal(notebook(notebook(frontFolder).parentId).name, "guides");
  assert.equal(notebook(notebook(frontFolder).parentId).parentId, ROOT);
  const nodes = db().prepare("SELECT resourceId, parentId FROM knowledge_tree_nodes WHERE resourceType = 'notebook' AND resourceId IN (?, ?)").all(frontFolder,backendFolder);
  assert.equal(nodes.length, 2, "new folders must enter the unified knowledge tree");

  const r = await post("import-file", payload("guides/frontend/readme.md", "frontend contents"));
  assert.equal(r.status, 200);
  assert.equal(r.body.skipped, true);
  assert.equal(r.body.noteId, a.body.noteId);
  const childCount = db().prepare("SELECT COUNT(*) AS count FROM notebooks WHERE parentId = ?")
    .get(notebook(frontFolder).parentId) as { count: number };
  assert.equal(childCount.count, 2);
});

test("different sources use separate managed notebook IDs under the same target", async () => {
  const response = await post("import-file", {
    ...payload("guides/frontend/same.md", "second source"), sourceFolderId: "another-local-root",
    sourcePathHash: sha("other-source"),
  });
  assert.equal(response.status, 200);
  const other = note(response.body.noteId).notebookId;
  const prior = (db().prepare("SELECT id FROM notebooks WHERE name = 'frontend' AND parentId != ? LIMIT 1").get(other) as any);
  assert.ok(prior);
  assert.notEqual(other, prior.id);
});

test("opt-in can relocate existing flat-mode files without rewriting their content", async () => {
  const flat = await post("import-file", payload("archive/2026/memo.md", "important manual record",sha("flat-memo"), false));
  assert.equal(flat.status, 200);
  const before = note(flat.body.noteId);
  assert.equal(before.notebookId, ROOT);
  const organized = await post("organize-file", {
    relativePath: "archive/2026/memo.md", targetNotebookId: ROOT,
    sourcePathHash: sha("flat-memo"), sourceFolderId: FOLDER_ID,
  });
  assert.equal(organized.status, 200, JSON.stringify(organized.body));
  assert.equal(organized.body.moved, true);
  const after = note(flat.body.noteId);
  assert.equal(after.content, before.content);
  assert.equal(after.title, before.title);
  assert.equal(notebook(after.notebookId).name, "2026");
  assert.equal(notebook(notebook(after.notebookId).parentId).name, "archive");

  const again = await post("organize-file", {
    relativePath: "archive/2026/memo.md", targetNotebookId: ROOT,
    sourcePathHash: sha("flat-memo"), sourceFolderId: FOLDER_ID,
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.moved, false);
  assert.equal(note(flat.body.noteId).version, after.version);
});

test("wrong source hash, forged path, deleted managed folder and manually moved note are blocked", async () => {
  const badSource = await post("organize-file", {
    relativePath: "archive/2026/memo.md", targetNotebookId: ROOT,
    sourcePathHash: sha("unknown"), sourceFolderId: FOLDER_ID,
  });
  assert.equal(badSource.status, 409);
  const traversal = await post("import-file", payload("../private/key.md", "unsafe"));
  assert.equal(traversal.status, 400);
  const invalid = await post("import-file", payload("a//b/file.md", "unsafe"));
  assert.equal(invalid.status, 400);
  const other = await post("import-file", payload("changed/location.md", "unchanged source", sha("moved")));
  assert.equal(other.status, 200);
  const movedId = other.body.noteId;
  const manualId = "manually-created-other-folder";
  db().prepare("INSERT INTO notebooks (id, userId, parentId, name) VALUES (?, ?, ?, ?)")
    .run(manualId, USER, ROOT, "Moved manually");
  db().prepare("UPDATE notes SET notebookId = ? WHERE id = ?").run(manualId, movedId);
  const refused = await post("organize-file", {
    relativePath: "changed/location.md", targetNotebookId: ROOT,
    sourcePathHash: sha("moved"), sourceFolderId: FOLDER_ID,
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "LOCATION_CONFLICT");
  assert.equal(note(movedId).notebookId, manualId);
});
