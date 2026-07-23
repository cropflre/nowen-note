import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { getDb } from "../src/db/schema";
import {
  applyRoundTripPermissionMappings,
  buildRoundTripPermissionsManifest,
  createNowenPackageWithPermissions,
  previewRoundTripPermissionMappings,
} from "../src/services/roundTripPermissionMapping";

function reset(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM workspace_members;
    DELETE FROM workspace_invites;
    DELETE FROM workspaces;
    DELETE FROM notes;
    DELETE FROM notebooks;
    DELETE FROM users;
  `);
}

function user(id: string, username: string, email: string | null = null, role = "user"): void {
  getDb().prepare(`
    INSERT INTO users (id, username, email, passwordHash, displayName, role)
    VALUES (?, ?, ?, 'hash', ?, ?)
  `).run(id, username, email, username, role);
}

function workspace(id: string, ownerId: string): void {
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, description, ownerId) VALUES (?, ?, '', ?)")
    .run(id, `Workspace ${id}`, ownerId);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, 'owner')")
    .run(id, ownerId);
}

test.beforeEach(reset);

test("exports only minimal member identity and roles", () => {
  user("owner", "owner-user", "owner@example.com");
  user("editor", "editor-user", "editor@example.com");
  workspace("source", "owner");
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, 'editor')")
    .run("source", "editor");

  const manifest = buildRoundTripPermissionsManifest("owner", "source");
  assert.equal(manifest.format, "nowen-workspace-permissions");
  assert.equal(manifest.members.length, 2);
  assert.deepEqual(Object.keys(manifest.members[0] || {}).sort(), [
    "displayName", "email", "role", "sourceUserId", "username",
  ]);
  assert.equal(JSON.stringify(manifest).includes("passwordHash"), false);
});

test("rejects permission export by non-owner workspace members", () => {
  user("owner", "owner-user");
  user("editor", "editor-user");
  workspace("source", "owner");
  getDb().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, 'editor')")
    .run("source", "editor");

  assert.throws(() => buildRoundTripPermissionsManifest("editor", "source"), /所有者/);
});

test("embeds permissions.json only in the explicit privileged package endpoint", async () => {
  user("owner", "owner-user", "owner@example.com");
  workspace("source", "owner");
  getDb().prepare(`
    INSERT INTO notebooks (id, userId, workspaceId, name, icon)
    VALUES ('notebook-1', 'owner', 'source', 'Root', '📒')
  `).run();

  const result = await createNowenPackageWithPermissions({ userId: "owner", workspaceId: "source" });
  const zip = await JSZip.loadAsync(result.buffer);
  assert.ok(zip.file("permissions.json"));
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  assert.equal(manifest.permissions?.included, true);
  assert.equal(manifest.permissions?.memberCount, 1);
});

test("previews exact email matches and downgrades imported owner role", () => {
  user("target-owner", "target-owner");
  user("target-editor", "renamed-user", "same@example.com");
  workspace("target", "target-owner");

  const suggestions = previewRoundTripPermissionMappings("target-owner", "target", {
    format: "nowen-workspace-permissions",
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceWorkspace: { id: "source", name: "Source" },
    members: [{
      sourceUserId: "source-owner",
      username: "old-name",
      email: "same@example.com",
      displayName: "Old",
      role: "owner",
    }],
  });

  assert.equal(suggestions[0]?.match, "email");
  assert.equal(suggestions[0]?.suggestedTargetUserId, "target-editor");
  assert.equal(suggestions[0]?.appliedRole, "admin");
  assert.match(suggestions[0]?.warning || "", /降级/);
});

test("applies only explicit mappings and never replaces the target owner", () => {
  user("target-owner", "target-owner");
  user("mapped", "mapped-user");
  workspace("target", "target-owner");
  const manifest = {
    format: "nowen-workspace-permissions",
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceWorkspace: { id: "source", name: "Source" },
    members: [
      { sourceUserId: "source-owner", username: "source-owner", email: null, displayName: null, role: "owner" },
      { sourceUserId: "source-editor", username: "source-editor", email: null, displayName: null, role: "editor" },
    ],
  } as const;

  const result = applyRoundTripPermissionMappings({
    actorUserId: "target-owner",
    workspaceId: "target",
    manifest,
    mappings: [
      { sourceUserId: "source-owner", targetUserId: "target-owner" },
      { sourceUserId: "source-editor", targetUserId: "mapped" },
    ],
  });
  assert.equal(result.applied, 1);
  assert.equal(result.skipped, 1);
  const owner = getDb().prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get("target", "target-owner") as { role: string };
  const mapped = getDb().prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get("target", "mapped") as { role: string };
  assert.equal(owner.role, "owner");
  assert.equal(mapped.role, "editor");
});
