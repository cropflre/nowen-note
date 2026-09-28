import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-obsidian-v2-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const USER_ID = "obsidian-v2-user";
let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

function db() {
  return getDb();
}

function jsonHeaders() {
  return {
    "X-User-Id": USER_ID,
    "Content-Type": "application/json",
  };
}

test.before(async () => {
  const [schema, exportRoutes, knowledgeRoutes] = await Promise.all([
    import("../src/db/schema.js"),
    import("../src/routes/export.js"),
    import("../src/routes/knowledge-tree.js"),
  ]);
  getDb = schema.getDb;
  closeDb = schema.closeDb;
  app = new Hono();
  app.route("/export", exportRoutes.default);
  app.route("/knowledge-tree", knowledgeRoutes.default);

  const filesObject = db().prepare(
    "SELECT type FROM sqlite_master WHERE name = 'files'",
  ).get() as { type: string } | undefined;
  if (!filesObject) {
    db().exec("CREATE VIEW files AS SELECT id, filename FROM attachments");
  }
});

test.beforeEach(() => {
  db().exec(`
    DELETE FROM knowledge_tree_history;
    DELETE FROM knowledge_tree_acl;
    DELETE FROM knowledge_tree_nodes;
    DELETE FROM note_import_origins;
    DELETE FROM attachment_references;
    DELETE FROM attachments;
    DELETE FROM notes;
    DELETE FROM notebooks;
    DELETE FROM workspace_members;
    DELETE FROM workspaces;
    DELETE FROM users;
  `);
  db().prepare(
    "INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)",
  ).run(USER_ID, USER_ID, "hash");
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.ELECTRON_USER_DATA;
});

test("persistent import origins resolve the same Obsidian source without creating a second mapping", async () => {
  db().prepare(
    "INSERT INTO notebooks (id, userId, name) VALUES ('nb-origin', ?, 'Vault')",
  ).run(USER_ID);
  db().prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
    VALUES ('note-origin', ?, 'nb-origin', 'A', '# A', 'A', 'markdown')
  `).run(USER_ID);

  let response = await app.request("/export/import/origins/register?workspaceId=personal", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      sourceType: "obsidian-vault",
      externalId: "Vault/docs/A.md",
      noteId: "note-origin",
      metadata: { vaultPath: "docs/A.md" },
    }),
  });
  assert.equal(response.status, 201, await response.text());
  assert.deepEqual(await response.json(), {
    created: true,
    conflict: false,
    noteId: "note-origin",
  });

  response = await app.request("/export/import/origins/register?workspaceId=personal", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      sourceType: "obsidian-vault",
      externalId: "Vault/docs/A.md",
      noteId: "note-origin",
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    created: false,
    conflict: false,
    noteId: "note-origin",
  });

  response = await app.request("/export/import/origins/resolve?workspaceId=personal", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      sourceType: "obsidian-vault",
      externalIds: ["Vault/docs/A.md", "Vault/docs/Unknown.md"],
    }),
  });
  assert.equal(response.status, 200);
  const resolved = await response.json() as any;
  assert.equal(resolved.origins["Vault/docs/A.md"].noteId, "note-origin");
  assert.equal(resolved.origins["Vault/docs/A.md"].title, "A");
  assert.equal(resolved.origins["Vault/docs/Unknown.md"], undefined);
  assert.equal(
    (db().prepare("SELECT COUNT(*) AS count FROM note_import_origins").get() as { count: number }).count,
    1,
  );
});

test("imported attachments can be linked into their original Vault directory as file nodes", async () => {
  db().prepare(
    "INSERT INTO notebooks (id, userId, name) VALUES ('holder-nb', ?, 'holder')",
  ).run(USER_ID);
  db().prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, isArchived)
    VALUES ('holder-note', ?, 'holder-nb', 'holder', '{}', '', 1)
  `).run(USER_ID);
  db().prepare(`
    INSERT INTO attachments (
      id, noteId, userId, filename, mimeType, size, path, uploadSource
    ) VALUES (
      'asset-pdf', 'holder-note', ?, '说明.pdf', 'application/pdf', 3, '2026/09/asset-pdf.pdf', 'file_manager'
    )
  `).run(USER_ID);

  const response = await app.request("/knowledge-tree/files/link?workspaceId=personal", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      fileId: "asset-pdf",
      notebookPath: ["Imported Vault", "docs"],
    }),
  });
  assert.equal(response.status, 201, await response.text());
  const linked = await response.json() as any;
  assert.equal(linked.id, "file:asset-pdf");
  assert.equal(linked.resourceType, "file");
  assert.equal(linked.resourceId, "asset-pdf");
  assert.equal(linked.title, "说明.pdf");

  const fileNode = db().prepare(`
    SELECT id, parentId, nodeType, resourceType, resourceId
    FROM knowledge_tree_nodes WHERE id = 'file:asset-pdf'
  `).get() as any;
  assert.equal(fileNode.nodeType, "file");
  assert.equal(fileNode.resourceType, "file");

  const docs = db().prepare(`
    SELECT id, parentId, name FROM notebooks
    WHERE userId = ? AND name = 'docs' AND workspaceId IS NULL
  `).get(USER_ID) as { id: string; parentId: string; name: string };
  const root = db().prepare(
    "SELECT id, name FROM notebooks WHERE id = ?",
  ).get(docs.parentId) as { id: string; name: string };
  assert.equal(root.name, "Imported Vault");
  assert.equal(fileNode.parentId, `notebook:${docs.id}`);

  const second = await app.request("/knowledge-tree/files/link?workspaceId=personal", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      fileId: "asset-pdf",
      notebookPath: ["Imported Vault", "docs"],
    }),
  });
  assert.equal(second.status, 200, await second.text());
  assert.equal(
    (db().prepare(
      "SELECT COUNT(*) AS count FROM knowledge_tree_nodes WHERE resourceType = 'file' AND resourceId = 'asset-pdf'",
    ).get() as { count: number }).count,
    1,
  );
});

test("file linking rejects attachments from another personal account", async () => {
  db().prepare(
    "INSERT INTO users (id, username, passwordHash) VALUES ('other-user', 'other-user', 'hash')",
  ).run();
  db().prepare(
    "INSERT INTO notebooks (id, userId, name) VALUES ('other-nb', 'other-user', 'Other')",
  ).run();
  db().prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText)
    VALUES ('other-note', 'other-user', 'other-nb', 'Other', '{}', '')
  `).run();
  db().prepare(`
    INSERT INTO attachments (
      id, noteId, userId, filename, mimeType, size, path
    ) VALUES (
      'other-file', 'other-note', 'other-user', 'private.txt', 'text/plain', 1, 'private.txt'
    )
  `).run();

  const response = await app.request("/knowledge-tree/files/link?workspaceId=personal", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      fileId: "other-file",
      notebookPath: ["Imported Vault"],
    }),
  });
  assert.equal(response.status, 404);
});
