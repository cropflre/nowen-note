import assert from "node:assert/strict";
import test from "node:test";

test("unified trash lifecycle", async (t) => {
await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
const { getDb } = await import("../src/db/schema.js");
const { createKnowledgeChild, deleteKnowledgeNode } = await import("../src/services/knowledgeTree.js");
const { setKnowledgeNodeDenied } = await import("../src/services/knowledgeDenyPolicy.js");
const { setKnowledgeNodeRole } = await import("../src/services/knowledgeCapabilities.js");
const { listTrash, mutateTrash, emptyTrash } = await import("../src/services/trash/trashService.js");
const { Hono } = await import("hono");
const router = (await import("../src/routes/trash.js")).default;
const db = getDb();
for (const id of ["trash-owner", "trash-other", "trash-member"]) {
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(id, id);
}
const scope = { userId: "trash-owner", workspaceId: null };
const app = new Hono();
app.route("/api/trash", router);
const create = (title: string, nodeType: "folder" | "note" | "markdown" | "mindmap" | "sheet" = "folder", parentId: string | null = null, workspaceId: string | null = null) =>
  createKnowledgeChild({ actorUserId: scope.userId, workspaceId, parentId, nodeType, title, db });
const trash = (id: string) => deleteKnowledgeNode({ actorUserId: scope.userId, nodeId: id, mode: "subtree", db });
const deleted = (id: string) => (db.prepare("SELECT isDeleted FROM knowledge_tree_nodes WHERE id = ?").get(id) as { isDeleted: number } | undefined)?.isDeleted;

await t.test("unified listing uses deletion time, original paths and sheet resource type without exposing active resources", () => {
  const folder = create("Original location");
  const note = create("Markdown", "markdown", folder.id);
  const sheet = create("Sheet", "sheet", folder.id);
  const map = create("Map", "mindmap", folder.id);
  trash(folder.id);
  const items = listTrash(scope).filter((item) => [folder.id, note.id, sheet.id, map.id].includes(item.id));
  assert.equal(items.length, 4);
  assert.equal(items.find((item) => item.id === sheet.id)?.resourceType, "sheet");
  assert.deepEqual(items.find((item) => item.id === note.id)?.originalPath, ["Original location"]);
  assert.ok(items.every((item) => item.deletedAt && item.canRestore && item.canDeletePermanently));
  assert.deepEqual(listTrash({ userId: "trash-other", workspaceId: null }), []);
  const active = create("Active", "note");
  assert.equal(listTrash(scope).some((item) => item.id === active.id), false);
});

await t.test("restoring a child restores necessary ancestors and their cohort while retaining older deleted siblings and IDs", () => {
  const parent = create("Restore parent");
  const old = create("Older deletion", "note", parent.id);
  const map = create("Restore map", "mindmap", parent.id);
  trash(old.id);
  trash(parent.id);
  const result = mutateTrash(scope, "restore", [map.id, parent.id]);
  assert.deepEqual(result.failures, []);
  assert.equal(deleted(parent.id), 0);
  assert.equal(deleted(map.id), 0);
  assert.equal(deleted(old.id), 1);
  assert.ok(db.prepare("SELECT id FROM mindmaps WHERE id = ?").get(map.resourceId));
});

await t.test("permanent batch deletes mixed descendants before folders and preserves an active document", () => {
  const parent = create("Delete mixed");
  const note = create("Delete note", "note", parent.id);
  const map = create("Delete map", "mindmap", parent.id);
  const sheet = create("Delete sheet", "sheet", parent.id);
  const active = create("Keep active", "note");
  trash(parent.id);
  const result = mutateTrash(scope, "permanent", [parent.id]);
  assert.deepEqual(result.failures, []);
  assert.equal(result.succeededIds.length, 4);
  assert.deepEqual(new Set(result.noteIds), new Set([note.resourceId, sheet.resourceId]));
  assert.equal(deleted(parent.id), undefined);
  assert.equal(db.prepare("SELECT id FROM mindmaps WHERE id = ?").get(map.resourceId), undefined);
  assert.equal(db.prepare("SELECT noteId FROM sheets WHERE noteId = ?").get(sheet.resourceId), undefined);
  assert.equal(deleted(active.id), 0);
});

await t.test("locked descendants survive empty trash and prevent notebook FK cascade deletion", () => {
  const parent = create("Protected parent");
  const note = create("Locked", "note", parent.id);
  const map = create("Removable", "mindmap", parent.id);
  trash(parent.id);
  db.prepare("UPDATE notes SET isLocked = 1 WHERE id = ?").run(note.resourceId);
  const result = emptyTrash(scope);
  assert.equal(deleted(note.id), 1);
  assert.equal(deleted(parent.id), 1);
  assert.equal(deleted(map.id), undefined);
  assert.equal(result.failures.find((item) => item.id === note.id)?.code, "TRASH_DELETE_FORBIDDEN");
  assert.equal(result.failures.find((item) => item.id === parent.id)?.code, "TRASH_CONTAINER_NOT_EMPTY");
});

await t.test("scope and tombstone ACL checks block cross-user, cross-workspace and explicit-deny mutations", () => {
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES ('trash-ws', 'Trash team', ?)").run(scope.userId);
  for (const [id, role] of [[scope.userId, "owner"], ["trash-member", "editor"]]) {
    db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('trash-ws', ?, ?)").run(id, role);
  }
  const folder = create("Restricted", "folder", null, "trash-ws");
  const child = create("Hidden child", "note", folder.id, "trash-ws");
  setKnowledgeNodeDenied({ actorUserId: scope.userId, nodeId: child.id, targetUserId: "trash-member", db });
  trash(folder.id);
  const teamScope = { userId: "trash-member", workspaceId: "trash-ws" };
  assert.equal(listTrash(teamScope).some((item) => item.id === child.id), false);
  assert.equal(mutateTrash(teamScope, "restore", [child.id]).failures.length, 1);
  assert.equal(mutateTrash(scope, "permanent", [child.id]).failures.length, 1);
  assert.deepEqual(listTrash({ userId: "trash-other", workspaceId: "trash-ws" }), []);
  assert.equal(deleted(child.id), 1);
  assert.equal(listTrash(teamScope).find((item) => item.id === folder.id)?.canRestore, false);
});

await t.test("restricted parent restoration is denied and leaves the child unchanged", () => {
  const parent = create("Denied parent", "folder", null, "trash-ws");
  const child = create("Shared deleted child", "note", parent.id, "trash-ws");
  setKnowledgeNodeDenied({ actorUserId: scope.userId, nodeId: parent.id, targetUserId: "trash-member", db });
  setKnowledgeNodeRole({ actorUserId: scope.userId, nodeId: child.id, targetUserId: "trash-member", rolePreset: "maintainer", db });
  trash(parent.id);
  const result = mutateTrash({ userId: "trash-member", workspaceId: "trash-ws" }, "restore", [child.id]);
  const listed = listTrash({ userId: "trash-member", workspaceId: "trash-ws" }).find((item) => item.id === child.id)!;
  assert.equal(listed.canRestore, false);
  assert.equal(listed.originalPathHidden, true);
  assert.equal(listed.originalPath.includes("Denied parent"), false);
  assert.equal(result.failures.length, 1);
  assert.equal(deleted(parent.id), 1);
  assert.equal(deleted(child.id), 1);
});

await t.test("API validates batch requests, requires identity and never permanently deletes an active resource", async () => {
  const active = create("API active", "note");
  const headers = { "X-User-Id": scope.userId, "Content-Type": "application/json" };
  assert.equal((await app.request("/api/trash")).status, 401);
  assert.equal((await app.request("/api/trash", { headers: { ...headers, "X-Auth-Mode": "api-token" } })).status, 403);
  for (const body of [{ action: "bad", ids: [active.id] }, { action: "permanent", ids: [] }, { action: "permanent", ids: [42] }]) {
    assert.equal((await app.request("/api/trash/batch", { method: "POST", headers, body: JSON.stringify(body) })).status, 400);
  }
  const response = await app.request("/api/trash/batch", { method: "POST", headers, body: JSON.stringify({ action: "permanent", ids: [active.id] }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { failures: unknown[] }).failures.length, 1);
  assert.equal(deleted(active.id), 0);
});

await t.test("folder deletion cannot cascade across a hidden descendant ACL", () => {
  const parent = create("Shared container", "folder", null, "trash-ws");
  const hidden = create("Hidden protected note", "note", parent.id, "trash-ws");
  setKnowledgeNodeRole({ actorUserId: scope.userId, nodeId: parent.id, targetUserId: "trash-member", rolePreset: "maintainer", db });
  setKnowledgeNodeDenied({ actorUserId: scope.userId, nodeId: hidden.id, targetUserId: "trash-member", db });
  trash(parent.id);
  const result = mutateTrash({ userId: "trash-member", workspaceId: "trash-ws" }, "permanent", [parent.id]);
  assert.equal(result.failures[0]?.code, "TRASH_CONTAINER_NOT_EMPTY");
  assert.equal(deleted(hidden.id), 1);
  assert.equal(deleted(parent.id), 1);
});

await t.test("failed descendant restore rolls back the entire ancestor restore transaction", () => {
  const parent = create("Atomic restore");
  const child = create("Failing child", "note", parent.id);
  trash(parent.id);
  db.exec(`CREATE TRIGGER trash_test_restore_failure BEFORE UPDATE OF isTrashed ON notes
    WHEN OLD.id = '${child.resourceId}' AND NEW.isTrashed = 0 BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
  try {
    const result = mutateTrash(scope, "restore", [child.id]);
    assert.equal(result.failures.length, 1);
    assert.equal(deleted(parent.id), 1);
    assert.equal(deleted(child.id), 1);
    assert.equal((db.prepare("SELECT isDeleted FROM notebooks WHERE id = ?").get(parent.resourceId) as { isDeleted: number }).isDeleted, 1);
  } finally {
    db.exec("DROP TRIGGER trash_test_restore_failure");
  }
});

});
