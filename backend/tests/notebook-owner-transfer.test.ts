import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-notebook-owner-transfer-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.ELECTRON_USER_DATA = dir;

let closeDb: () => void;

test("personal notebook owner can transfer the complete subtree to an existing collaborator", async () => {
  const [{ default: notebooksRouter }, schema] = await Promise.all([
    import("../src/routes/notebooks"),
    import("../src/db/schema"),
  ]);
  await import("../src/runtime/notebook-permission-management");
  closeDb = schema.closeDb;
  const db = schema.getDb();

  for (const id of ["owner", "target", "outsider"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(id, id);
  }
  db.prepare("INSERT INTO notebooks (id, userId, parentId, name) VALUES ('root', 'owner', NULL, 'Root')").run();
  db.prepare("INSERT INTO notebooks (id, userId, parentId, name) VALUES ('child', 'owner', 'root', 'Child')").run();
  db.prepare("INSERT INTO notes (id, userId, notebookId, title) VALUES ('note', 'owner', 'child', 'Note')").run();
  db.prepare(
    `INSERT INTO notebook_members (id, notebookId, userId, role, status, invitedBy)
     VALUES ('root:target', 'root', 'target', 'editor', 'active', 'owner')`,
  ).run();

  const app = new Hono();
  app.route("/notebooks", notebooksRouter);

  const summaryBefore = await app.request("/notebooks/root/permission-summary", {
    headers: { "X-User-Id": "owner" },
  });
  assert.equal(summaryBefore.status, 200);
  const before = await summaryBefore.json() as {
    ownerId: string;
    members: Array<{ userId: string; role: string }>;
  };
  assert.equal(before.ownerId, "owner");
  assert.deepEqual(before.members.map((row) => [row.userId, row.role]), [
    ["owner", "owner"],
    ["target", "editor"],
  ]);

  const outsider = await app.request("/notebooks/root/transfer-owner", {
    method: "POST",
    headers: { "X-User-Id": "owner", "Content-Type": "application/json" },
    body: JSON.stringify({ targetUserId: "outsider" }),
  });
  assert.equal(outsider.status, 400);

  const transferred = await app.request("/notebooks/root/transfer-owner", {
    method: "POST",
    headers: { "X-User-Id": "owner", "Content-Type": "application/json" },
    body: JSON.stringify({ targetUserId: "target" }),
  });
  assert.equal(transferred.status, 200);
  const result = await transferred.json() as {
    previousOwnerId: string;
    newOwnerId: string;
    notebookCount: number;
    noteCount: number;
  };
  assert.equal(result.previousOwnerId, "owner");
  assert.equal(result.newOwnerId, "target");
  assert.equal(result.notebookCount, 2);
  assert.equal(result.noteCount, 1);

  const notebooks = db.prepare("SELECT id, userId FROM notebooks ORDER BY id").all() as Array<{ id: string; userId: string }>;
  assert.deepEqual(notebooks, [
    { id: "child", userId: "target" },
    { id: "root", userId: "target" },
  ]);
  const note = db.prepare("SELECT userId FROM notes WHERE id = 'note'").get() as { userId: string };
  assert.equal(note.userId, "target");

  const summaryAfter = await app.request("/notebooks/root/permission-summary", {
    headers: { "X-User-Id": "target" },
  });
  assert.equal(summaryAfter.status, 200);
  const after = await summaryAfter.json() as {
    ownerId: string;
    members: Array<{ userId: string; role: string }>;
  };
  assert.equal(after.ownerId, "target");
  assert.deepEqual(after.members.map((row) => [row.userId, row.role]), [
    ["target", "owner"],
    ["owner", "editor"],
  ]);
});

test.after(() => {
  closeDb?.();
  fs.rmSync(dir, { recursive: true, force: true });
});
