import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-shared-tree-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let closeDb: (() => void) | undefined;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("shared-with-me returns only the complete authorized subtree", async () => {
  const [{ getDb, closeDb: close }, { default: notebookRoutes }] = await Promise.all([
    import("../src/db/schema"),
    import("../src/routes/notebooks"),
  ]);
  closeDb = close;
  const db = getDb();

  for (const user of ["owner", "viewer"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')")
      .run(user, user);
  }

  db.prepare("INSERT INTO notebooks (id, userId, parentId, name, sortOrder) VALUES (?, ?, NULL, ?, ?)")
    .run("ancestor", "owner", "Ancestor", 0);
  db.prepare("INSERT INTO notebooks (id, userId, parentId, name, sortOrder) VALUES (?, ?, ?, ?, ?)")
    .run("shared-root", "owner", "ancestor", "Shared root", 1);
  db.prepare("INSERT INTO notebooks (id, userId, parentId, name, sortOrder) VALUES (?, ?, ?, ?, ?)")
    .run("child", "owner", "shared-root", "Child", 2);
  db.prepare("INSERT INTO notebooks (id, userId, parentId, name, sortOrder) VALUES (?, ?, ?, ?, ?)")
    .run("grandchild", "owner", "child", "Grandchild", 3);
  db.prepare("INSERT INTO notebooks (id, userId, parentId, name, sortOrder) VALUES (?, ?, ?, ?, ?)")
    .run("sibling", "owner", "ancestor", "Private sibling", 4);
  db.prepare("INSERT INTO notebooks (id, userId, parentId, name, sortOrder, isDeleted) VALUES (?, ?, ?, ?, ?, 1)")
    .run("deleted-child", "owner", "shared-root", "Deleted", 5);

  db.prepare(`INSERT INTO notebook_members
    (id, notebookId, userId, role, status, allowDownload, allowReshare, source)
    VALUES (?, ?, ?, 'viewer', 'active', 1, 0, 'manual')`)
    .run("member-root", "shared-root", "viewer");

  db.prepare(`INSERT INTO notes
    (id, userId, notebookId, title, content, contentText, isTrashed)
    VALUES (?, ?, ?, ?, '{}', '', 0)`)
    .run("root-note", "owner", "shared-root", "Root note");
  db.prepare(`INSERT INTO notes
    (id, userId, notebookId, title, content, contentText, isTrashed)
    VALUES (?, ?, ?, ?, '{}', '', 0)`)
    .run("grand-note", "owner", "grandchild", "Grand note");

  const app = new Hono();
  app.route("/notebooks", notebookRoutes);
  const response = await app.request("/notebooks/shared-with-me", {
    headers: { "X-User-Id": "viewer" },
  });

  assert.equal(response.status, 200);
  const rows = await response.json() as Array<Record<string, any>>;
  assert.deepEqual(rows.map((row) => row.id), ["shared-root", "child", "grandchild"]);
  assert.equal(rows.some((row) => row.id === "ancestor"), false);
  assert.equal(rows.some((row) => row.id === "sibling"), false);
  assert.equal(rows.some((row) => row.id === "deleted-child"), false);

  const root = rows.find((row) => row.id === "shared-root")!;
  const child = rows.find((row) => row.id === "child")!;
  assert.equal(root.parentId, "ancestor");
  assert.equal(root.sharedRootId, "shared-root");
  assert.equal(root.noteCount, 2);
  assert.equal(child.sharedRootId, "shared-root");
  assert.equal(child.noteCount, 1);
  assert.equal(child.myRole, "viewer");
  assert.equal(child.permission, "read");
});
