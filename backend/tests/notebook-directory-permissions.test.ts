import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("directory ACL uses the nearest explicit rule and inherits root membership", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-notebook-acl-"));
  process.env.DB_PATH = path.join(tempDir, "test.db");

  const { getDb, closeDb } = await import("../src/db/schema");
  const {
    ensureNotebookAclOverridesTable,
    memberQueryService,
  } = await import("../src/queries/memberQueryService");

  try {
    const db = getDb();
    ensureNotebookAclOverridesTable();

    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
      .run("owner", "owner", "hash");
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
      .run("member", "member", "hash");

    db.prepare(`
      INSERT INTO notebooks (id, userId, parentId, name, isDeleted)
      VALUES (?, ?, NULL, ?, 0)
    `).run("root", "owner", "Root");
    db.prepare(`
      INSERT INTO notebooks (id, userId, parentId, name, isDeleted)
      VALUES (?, ?, ?, ?, 0)
    `).run("child", "owner", "root", "Child");
    db.prepare(`
      INSERT INTO notebooks (id, userId, parentId, name, isDeleted)
      VALUES (?, ?, ?, ?, 0)
    `).run("grandchild", "owner", "child", "Grandchild");

    db.prepare(`
      INSERT INTO notebook_members (id, notebookId, userId, role, status, invitedBy)
      VALUES (?, ?, ?, 'viewer', 'active', ?)
    `).run("root:member", "root", "member", "owner");

    assert.deepEqual(memberQueryService.getNotebookMemberAccess("grandchild", "member"), {
      role: "viewer",
      sourceNotebookId: "root",
      depth: 2,
      source: "member",
      allowDownload: 1,
      allowReshare: 0,
    });

    db.prepare(`
      INSERT INTO notebook_acl_overrides
        (notebookId, userId, permission, allowDownload, allowReshare, createdBy)
      VALUES (?, ?, 'none', 0, 0, ?)
    `).run("child", "member", "owner");

    assert.deepEqual(memberQueryService.getNotebookMemberAccess("grandchild", "member"), {
      role: "none",
      sourceNotebookId: "child",
      depth: 1,
      source: "override",
      allowDownload: 0,
      allowReshare: 0,
    });

    db.prepare(`
      INSERT INTO notebook_members (id, notebookId, userId, role, status, invitedBy)
      VALUES (?, ?, ?, 'editor', 'active', ?)
    `).run("grandchild:member", "grandchild", "member", "owner");

    assert.deepEqual(memberQueryService.getNotebookMemberAccess("grandchild", "member"), {
      role: "editor",
      sourceNotebookId: "grandchild",
      depth: 0,
      source: "member",
      allowDownload: 1,
      allowReshare: 0,
    });
  } finally {
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});
