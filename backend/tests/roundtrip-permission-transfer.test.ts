import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-permission-transfer-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.ROUNDTRIP_IMPORT_UNDO_TTL_HOURS = "24";
process.env.NOWEN_INSTANCE_ID = "permission-transfer-instance";

let closeDb: typeof import("../src/db/schema").closeDb;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seed() {
  const schema = await import("../src/db/schema");
  closeDb = schema.closeDb;
  const db = schema.getDb();
  db.prepare(`INSERT INTO users (id, username, email, passwordHash, role, displayName) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("operator", "operator", "operator@example.com", "hash", "admin", "Operator");
  db.prepare(`INSERT INTO users (id, username, email, passwordHash, displayName) VALUES (?, ?, ?, ?, ?)`)
    .run("source-member", "source-member", "source@example.com", "hash", "Source Member");
  db.prepare(`INSERT INTO users (id, username, email, passwordHash, displayName) VALUES (?, ?, ?, ?, ?)`)
    .run("target-member", "target-member", "target@example.com", "hash", "Target Member");

  db.prepare(`INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)`)
    .run("source-workspace", "来源工作区", "operator");
  db.prepare(`INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)`)
    .run("target-workspace", "目标工作区", "operator");
  db.prepare(`INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)`)
    .run("source-workspace", "operator", "owner");
  db.prepare(`INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)`)
    .run("source-workspace", "source-member", "editor");
  db.prepare(`INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)`)
    .run("target-workspace", "operator", "owner");
  db.prepare(`INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)`)
    .run("target-workspace", "target-member", "viewer");

  db.prepare(`
    INSERT INTO notebooks (id, userId, workspaceId, parentId, name, sortOrder, isExpanded)
    VALUES (?, ?, ?, NULL, ?, 0, 1)
  `).run("source-notebook", "operator", "source-workspace", "团队资料");
  db.prepare(`
    INSERT INTO notebook_members (
      id, notebookId, userId, role, status, allowDownload, allowReshare, source, invitedBy
    ) VALUES (?, ?, ?, ?, 'active', 1, 1, 'manual', ?)
  `).run("source-notebook-member", "source-notebook", "source-member", "editor", "operator");
  db.prepare(`
    INSERT INTO notes (
      id, userId, workspaceId, notebookId, title, content, contentText, contentFormat,
      sortOrder, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    "source-note",
    "operator",
    "source-workspace",
    "source-notebook",
    "权限迁移说明",
    "# 权限迁移",
    "权限迁移",
    "markdown",
    "2026-07-23 09:00:00",
    "2026-07-23 09:00:00",
  );
  return { db };
}

test("permission export is opt-in and explicit mappings can be safely undone", async () => {
  const { db } = await seed();
  const { createStableNowenPackageExport } = await import("../src/services/nowenPackageExportStable");
  const { importNowenPackage } = await import("../src/services/nowenPackageImport");
  const { undoRoundTripImportBatchWithLinksAndPermissions } = await import("../src/services/roundTripImportPermissionUndo");

  const defaultPackage = await createStableNowenPackageExport({
    userId: "operator",
    workspaceId: "source-workspace",
    packageKind: "nowen",
  });
  const defaultZip = await JSZip.loadAsync(defaultPackage.buffer);
  assert.equal(defaultZip.file("permissions.json"), null, "default export must not disclose member identities");

  const permissionPackage = await createStableNowenPackageExport({
    userId: "operator",
    workspaceId: "source-workspace",
    packageKind: "nowen",
    includePermissions: true,
  });
  const permissionZip = await JSZip.loadAsync(permissionPackage.buffer);
  const permissionEntry = permissionZip.file("permissions.json");
  assert.ok(permissionEntry);
  const permissionManifest = JSON.parse(await permissionEntry!.async("string")) as any;
  assert.equal(permissionManifest.version, 1);
  assert.equal(permissionManifest.workspace.sourceWorkspaceId, "source-workspace");
  assert.equal(permissionManifest.workspaceMembers.length, 2);
  assert.equal(permissionManifest.notebookMembers.length, 1);
  assert.equal(permissionManifest.principals.some((item: any) => item.email === "source@example.com"), true);

  const preview = await importNowenPackage(permissionPackage.buffer, {
    userId: "operator",
    workspaceId: "target-workspace",
    importMode: "new-root",
    dryRun: true,
  });
  assert.equal(preview.success, true, preview.errors?.join("; "));
  assert.equal(preview.package?.permissions?.included, true);
  assert.equal(preview.package?.permissions?.canApply, true);
  assert.equal(preview.package?.permissions?.counts?.principals, 2);

  const imported = await importNowenPackage(permissionPackage.buffer, {
    userId: "operator",
    workspaceId: "target-workspace",
    importMode: "new-root",
    applyPermissions: true,
    permissionMappings: {
      "source-member": "target-member",
    },
  });
  assert.equal(imported.success, true, imported.errors?.join("; "));
  assert.ok(imported.importBatch?.id);
  assert.equal(imported.permissionImport?.requested, true);
  assert.equal(imported.permissionImport?.applied, true);
  assert.equal(imported.permissionImport?.counts?.mappedPrincipals, 1);

  const targetMembership = db.prepare(`
    SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?
  `).get("target-workspace", "target-member") as { role: string } | undefined;
  assert.equal(targetMembership?.role, "editor", "an explicit mapping may upgrade but not downgrade a role");
  const ownerMembership = db.prepare(`
    SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?
  `).get("target-workspace", "operator") as { role: string } | undefined;
  assert.equal(ownerMembership?.role, "owner", "the target owner must never be replaced or downgraded");

  const importedRootId = String(imported.rootNotebookId || "");
  assert.ok(importedRootId);
  const directGrant = db.prepare(`
    SELECT role, allowDownload, allowReshare
      FROM notebook_members
     WHERE notebookId = ? AND userId = ? AND status = 'active'
  `).get(importedRootId, "target-member") as {
    role: string;
    allowDownload: number;
    allowReshare: number;
  } | undefined;
  assert.deepEqual(directGrant, { role: "editor", allowDownload: 1, allowReshare: 1 });

  const undone = await undoRoundTripImportBatchWithLinksAndPermissions("operator", String(imported.importBatch.id));
  assert.equal(undone.status, "undone");
  const restoredMembership = db.prepare(`
    SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?
  `).get("target-workspace", "target-member") as { role: string } | undefined;
  assert.equal(restoredMembership?.role, "viewer");
  const importedRootCount = db.prepare(`SELECT COUNT(*) AS count FROM notebooks WHERE id = ?`)
    .get(importedRootId) as { count: number };
  assert.equal(importedRootCount.count, 0);
});

test("permission undo refuses to overwrite later membership changes", async () => {
  const { createStableNowenPackageExport } = await import("../src/services/nowenPackageExportStable");
  const { importNowenPackage } = await import("../src/services/nowenPackageImport");
  const { undoRoundTripImportBatchWithLinksAndPermissions } = await import("../src/services/roundTripImportPermissionUndo");
  const { RoundTripImportUndoError } = await import("../src/services/roundTripImportBatches");
  const { getDb } = await import("../src/db/schema");
  const db = getDb();

  const permissionPackage = await createStableNowenPackageExport({
    userId: "operator",
    workspaceId: "source-workspace",
    packageKind: "nowen",
    includePermissions: true,
  });
  const imported = await importNowenPackage(permissionPackage.buffer, {
    userId: "operator",
    workspaceId: "target-workspace",
    importMode: "new-root",
    applyPermissions: true,
    permissionMappings: { "source-member": "target-member" },
  });
  assert.equal(imported.success, true);
  db.prepare(`UPDATE workspace_members SET role = 'admin' WHERE workspaceId = ? AND userId = ?`)
    .run("target-workspace", "target-member");

  await assert.rejects(
    () => undoRoundTripImportBatchWithLinksAndPermissions("operator", String(imported.importBatch.id)),
    (error: unknown) => {
      const candidate = error as { code?: string; conflicts?: string[] };
      assert.equal(candidate.code, "IMPORT_BATCH_UNDO_PERMISSION_CONFLICT");
      assert.ok(candidate.conflicts?.some((item) => item.includes("工作区成员")));
      return true;
    },
  );
  const row = db.prepare(`SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?`)
    .get("target-workspace", "target-member") as { role: string };
  assert.equal(row.role, "admin");
});
