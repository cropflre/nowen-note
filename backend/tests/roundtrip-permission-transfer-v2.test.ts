import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-permission-transfer-v2-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.ROUNDTRIP_IMPORT_UNDO_TTL_HOURS = "24";
process.env.NOWEN_INSTANCE_ID = "permission-transfer-v2-instance";

let closeDb: typeof import("../src/db/schema").closeDb;

async function modules() {
  const schema = await import("../src/db/schema");
  closeDb = schema.closeDb;
  const permission = await import("../src/services/roundTripPermissionTransfer");
  const exporter = await import("../src/services/nowenPackageExportStable");
  const importer = await import("../src/services/nowenPackageImport");
  const undo = await import("../src/services/roundTripImportPermissionUndo");
  return { ...schema, permission, exporter, importer, undo };
}

async function resetAndSeed() {
  const { getDb } = await modules();
  const db = getDb();
  db.exec(`
    DELETE FROM roundtrip_import_batches;
    DELETE FROM roundtrip_import_links;
    DELETE FROM notebook_members;
    DELETE FROM workspace_members;
    DELETE FROM workspace_invites;
    DELETE FROM attachments;
    DELETE FROM note_tags;
    DELETE FROM notes;
    DELETE FROM notebooks;
    DELETE FROM tags;
    DELETE FROM workspaces;
    DELETE FROM users;
  `);

  db.prepare(`INSERT INTO users (id, username, email, passwordHash, role, displayName) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("operator", "operator", "operator@example.com", "hash", "admin", "Operator");
  db.prepare(`INSERT INTO users (id, username, email, passwordHash, displayName) VALUES (?, ?, ?, ?, ?)`)
    .run("source-member", "source-member", "source@example.com", "hash", "Source Member");
  db.prepare(`INSERT INTO users (id, username, email, passwordHash, displayName) VALUES (?, ?, ?, ?, ?)`)
    .run("target-member", "target-member", "target@example.com", "hash", "Target Member");
  db.prepare(`INSERT INTO users (id, username, email, passwordHash, displayName) VALUES (?, ?, ?, ?, ?)`)
    .run("viewer", "viewer", "viewer@example.com", "hash", "Viewer");

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
  db.prepare(`INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)`)
    .run("target-workspace", "viewer", "admin");

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
  return db;
}

test.beforeEach(resetAndSeed);

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("permission export is opt-in and v2 includes direct notebook grants", async () => {
  const { exporter } = await modules();
  const defaultPackage = await exporter.createStableNowenPackageExport({
    userId: "operator",
    workspaceId: "source-workspace",
    packageKind: "nowen",
  });
  const defaultZip = await JSZip.loadAsync(defaultPackage.buffer);
  assert.equal(defaultZip.file("permissions.json"), null);

  const permissionPackage = await exporter.createStableNowenPackageExport({
    userId: "operator",
    workspaceId: "source-workspace",
    packageKind: "nowen",
    includePermissions: true,
  });
  const zip = await JSZip.loadAsync(permissionPackage.buffer);
  const permissions = JSON.parse(await zip.file("permissions.json")!.async("string"));
  assert.equal(permissions.format, "nowen-workspace-permissions");
  assert.equal(permissions.version, 2);
  assert.equal(permissions.sourceWorkspace.id, "source-workspace");
  assert.equal(permissions.workspaceMembers.length, 2);
  assert.equal(permissions.notebookMembers.length, 1);
  assert.equal(permissions.principals.some((item: any) => item.email === "source@example.com"), true);
});

test("explicit mapping upgrades without downgrade and can be safely undone", async () => {
  const db = await resetAndSeed();
  const { exporter, importer, undo } = await modules();
  const permissionPackage = await exporter.createStableNowenPackageExport({
    userId: "operator",
    workspaceId: "source-workspace",
    packageKind: "nowen",
    includePermissions: true,
  });

  const preview = await importer.importNowenPackage(permissionPackage.buffer, {
    userId: "operator",
    workspaceId: "target-workspace",
    importMode: "new-root",
    dryRun: true,
  });
  assert.equal(preview.success, true, preview.errors?.join("; "));
  assert.equal(preview.package?.permissions?.included, true);
  assert.equal(preview.package?.permissions?.valid, true);
  assert.equal(preview.package?.permissions?.canApply, true);
  assert.equal(preview.package?.permissions?.counts?.notebookMembers, 1);
  assert.equal(preview.package?.permissions?.principals?.find((item: any) => item.sourceUserId === "source-member")?.match, "email");

  const imported = await importer.importNowenPackage(permissionPackage.buffer, {
    userId: "operator",
    workspaceId: "target-workspace",
    importMode: "new-root",
    applyPermissions: true,
    permissionMappings: {
      "source-member": "target-member",
      operator: "viewer",
    },
  });
  assert.equal(imported.success, true, imported.errors?.join("; "));
  assert.ok(imported.importBatch?.id);
  assert.equal(imported.permissionImport?.requested, true);
  assert.equal(imported.permissionImport?.applied, true);

  const upgraded = db.prepare(`SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?`)
    .get("target-workspace", "target-member") as { role: string };
  assert.equal(upgraded.role, "editor");
  const preserved = db.prepare(`SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?`)
    .get("target-workspace", "viewer") as { role: string };
  assert.equal(preserved.role, "admin", "existing stronger role must not be downgraded");
  const owner = db.prepare(`SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?`)
    .get("target-workspace", "operator") as { role: string };
  assert.equal(owner.role, "owner");

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
  };
  assert.deepEqual(directGrant, { role: "editor", allowDownload: 1, allowReshare: 1 });

  const batch = db.prepare(`SELECT resultJson, undoStateJson FROM roundtrip_import_batches WHERE id = ?`)
    .get(String(imported.importBatch.id)) as { resultJson: string; undoStateJson: string };
  assert.equal(JSON.parse(batch.resultJson).permissionImport.applied, true);
  assert.equal(JSON.parse(batch.undoStateJson).permissionMembers.version, 2);

  const undone = await undo.undoRoundTripImportBatchWithLinksAndPermissions("operator", String(imported.importBatch.id));
  assert.equal(undone.status, "undone");
  const restored = db.prepare(`SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?`)
    .get("target-workspace", "target-member") as { role: string };
  assert.equal(restored.role, "viewer");
  const importedRootCount = db.prepare("SELECT COUNT(*) AS count FROM notebooks WHERE id = ?")
    .get(importedRootId) as { count: number };
  assert.equal(importedRootCount.count, 0);
});

test("permission undo refuses to overwrite later membership changes", async () => {
  const db = await resetAndSeed();
  const { exporter, importer, undo } = await modules();
  const permissionPackage = await exporter.createStableNowenPackageExport({
    userId: "operator",
    workspaceId: "source-workspace",
    packageKind: "nowen",
    includePermissions: true,
  });
  const imported = await importer.importNowenPackage(permissionPackage.buffer, {
    userId: "operator",
    workspaceId: "target-workspace",
    importMode: "new-root",
    applyPermissions: true,
    permissionMappings: { "source-member": "target-member" },
  });
  db.prepare("UPDATE workspace_members SET role = 'admin' WHERE workspaceId = ? AND userId = ?")
    .run("target-workspace", "target-member");

  await assert.rejects(
    () => undo.undoRoundTripImportBatchWithLinksAndPermissions("operator", String(imported.importBatch.id)),
    (error: unknown) => {
      const candidate = error as { code?: string; conflicts?: string[] };
      assert.equal(candidate.code, "IMPORT_BATCH_UNDO_PERMISSION_CONFLICT");
      assert.ok(candidate.conflicts?.some((item) => item.includes("工作区成员")));
      return true;
    },
  );
});

test("legacy v1 manifests remain readable", async () => {
  const { exporter, importer } = await modules();
  const result = await exporter.createStableNowenPackageExport({
    userId: "operator",
    workspaceId: "source-workspace",
    packageKind: "nowen",
  });
  const zip = await JSZip.loadAsync(result.buffer);
  zip.file("permissions.json", JSON.stringify({
    format: "nowen-workspace-permissions",
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceWorkspace: { id: "source-workspace", name: "来源工作区" },
    members: [{
      sourceUserId: "source-member",
      username: "source-member",
      email: "target@example.com",
      displayName: "Source Member",
      role: "editor",
    }],
  }));
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const preview = await importer.importNowenPackage(buffer, {
    userId: "operator",
    workspaceId: "target-workspace",
    importMode: "new-root",
    dryRun: true,
  });
  assert.equal(preview.package?.permissions?.included, true);
  assert.equal(preview.package?.permissions?.valid, true);
  assert.equal(preview.package?.permissions?.counts?.workspaceMembers, 1);
  assert.equal(preview.package?.permissions?.counts?.notebookMembers, 0);
});

test("malformed permissions.json is reported instead of treated as absent", async () => {
  const { exporter, importer } = await modules();
  const result = await exporter.createStableNowenPackageExport({
    userId: "operator",
    workspaceId: "source-workspace",
    packageKind: "nowen",
  });
  const zip = await JSZip.loadAsync(result.buffer);
  zip.file("permissions.json", "{broken");
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const preview = await importer.importNowenPackage(buffer, {
    userId: "operator",
    workspaceId: "target-workspace",
    importMode: "new-root",
    dryRun: true,
  });
  assert.equal(preview.package?.permissions?.included, true);
  assert.equal(preview.package?.permissions?.valid, false);
  assert.ok(preview.package?.permissions?.issues?.some((item: string) => item.includes("有效 JSON")));
});
