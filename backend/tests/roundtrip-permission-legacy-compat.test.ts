import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-permission-legacy-compat-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let closeDb: typeof import("../src/db/schema").closeDb;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("integrated permission preflight accepts the earlier workspace-only manifest", async () => {
  const schema = await import("../src/db/schema");
  closeDb = schema.closeDb;
  const db = schema.getDb();
  db.prepare(`INSERT INTO users (id, username, email, passwordHash, role, displayName) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("actor", "actor", "actor@example.com", "hash", "admin", "Actor");
  db.prepare(`INSERT INTO users (id, username, email, passwordHash, displayName) VALUES (?, ?, ?, ?, ?)`)
    .run("target-user", "target-user", "legacy@example.com", "hash", "Target User");
  db.prepare(`INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)`)
    .run("target-workspace", "目标工作区", "actor");
  db.prepare(`INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)`)
    .run("target-workspace", "actor", "owner");

  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({
    format: "nowen-package",
    formatVersion: 2,
    app: "nowen-note",
    packageKind: "nowen",
    exportedAt: "2026-07-23T00:00:00.000Z",
    sourceInstanceId: "legacy-permission-source",
  }));
  zip.file("permissions.json", JSON.stringify({
    format: "nowen-workspace-permissions",
    version: 1,
    exportedAt: "2026-07-23T00:00:00.000Z",
    sourceWorkspace: { id: "legacy-workspace", name: "旧版来源工作区" },
    members: [{
      sourceUserId: "legacy-member",
      username: "legacy-user",
      email: "legacy@example.com",
      displayName: "Legacy User",
      role: "editor",
    }],
  }));

  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const { inspectRoundTripPermissions } = await import("../src/services/roundTripPermissionTransfer");
  const inspection = await inspectRoundTripPermissions(buffer, {
    userId: "actor",
    workspaceId: "target-workspace",
  });

  assert.equal(inspection.included, true);
  assert.equal(inspection.valid, true, inspection.issues.join("; "));
  assert.equal(inspection.canApply, true);
  assert.deepEqual(inspection.counts, { principals: 1, workspaceMembers: 1, notebookMembers: 0 });
  assert.equal(inspection.principals[0]?.sourceUserId, "legacy-member");
  assert.equal(inspection.principals[0]?.workspaceRole, "editor");
  assert.equal(inspection.principals[0]?.match, "email");
  assert.equal(inspection.principals[0]?.suggestedTarget?.id, "target-user");
});
