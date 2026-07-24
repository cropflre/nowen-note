import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-permission-undo-auth-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let closeDb: typeof import("../src/db/schema").closeDb;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("permission undo rechecks that the importer is still workspace owner/admin", async () => {
  const schema = await import("../src/db/schema");
  closeDb = schema.closeDb;
  const db = schema.getDb();
  const { undoRoundTripImportBatchWithLinksAndPermissions } = await import("../src/services/roundTripImportPermissionUndo");

  db.prepare("INSERT INTO users (id, username, passwordHash, role) VALUES (?, ?, ?, ?)")
    .run("owner", "owner", "hash", "user");
  db.prepare("INSERT INTO users (id, username, passwordHash, role) VALUES (?, ?, ?, ?)")
    .run("importer", "importer", "hash", "user");
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run("target-workspace", "Target", "owner");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run("target-workspace", "owner", "owner");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run("target-workspace", "importer", "admin");

  const undoStateJson = JSON.stringify({
    permissionMembers: {
      version: 2,
      workspaceId: "target-workspace",
      rows: [],
    },
  });
  db.prepare(`
    INSERT INTO roundtrip_import_batches (
      id, userId, workspaceId, workspaceScope, importMode, packageKind,
      status, previewJson, resultJson, undoStateJson, undoAvailable,
      createdAt, completedAt
    ) VALUES (?, ?, ?, ?, ?, ?, 'completed', '{}', '{}', ?, 1, datetime('now'), datetime('now'))
  `).run(
    "batch-auth",
    "importer",
    "target-workspace",
    "target-workspace",
    "new-root",
    "nowen",
    undoStateJson,
  );

  db.prepare("UPDATE workspace_members SET role = 'editor' WHERE workspaceId = ? AND userId = ?")
    .run("target-workspace", "importer");

  await assert.rejects(
    () => undoRoundTripImportBatchWithLinksAndPermissions("importer", "batch-auth"),
    (error: unknown) => {
      const candidate = error as { code?: string; status?: number };
      assert.equal(candidate.code, "IMPORT_BATCH_UNDO_PERMISSION_FORBIDDEN");
      assert.equal(candidate.status, 403);
      return true;
    },
  );
});
