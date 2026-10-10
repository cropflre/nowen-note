import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

test("live knowledge tree confirms only current, correctly bound unlock tokens within the visible scope", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const [{ getDb }, { createKnowledgeChild }, { wrapKnowledgeRoute }, { default: treeRoutes }, { signFolderUnlockToken }] = await Promise.all([
    import("../src/db/schema.js"),
    import("../src/services/knowledgeTree.js"),
    import("../src/runtime/knowledge-tree.js"),
    import("../src/routes/knowledge-tree.js"),
    import("../src/lib/knowledgeTreePasswordAccess.js"),
  ]);
  const db = getDb();
  const userId = "tree-unlock-confirmation-owner";
  const otherUserId = "tree-unlock-confirmation-other";
  for (const id of [userId, otherUserId]) {
    db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(id, id, "hash");
  }
  const outer = createKnowledgeChild({ actorUserId: userId, workspaceId: null, parentId: null, nodeType: "folder", title: "outer", db });
  const inner = createKnowledgeChild({ actorUserId: userId, workspaceId: null, parentId: outer.id, nodeType: "folder", title: "inner", db });
  const other = createKnowledgeChild({ actorUserId: otherUserId, workspaceId: null, parentId: null, nodeType: "folder", title: "other", db });
  const note = createKnowledgeChild({ actorUserId: userId, workspaceId: null, parentId: inner.id, nodeType: "note", title: "protected", db });
  for (const folder of [outer, inner, other]) {
    db.prepare("INSERT INTO notebook_passwords (notebookId, passwordHash, passwordVersion) VALUES (?, ?, ?)")
      .run(folder.resourceId, "unused-hash", 3);
  }
  const unlock = (folder: typeof outer, actor = userId, notebookId = folder.resourceId) => signFolderUnlockToken({
    userId: actor, nodeId: folder.id, notebookId, passwordVersion: 3,
  });
  const app = new Hono();
  app.route("/api/knowledge-tree", wrapKnowledgeRoute("/api/knowledge-tree", treeRoutes));
  const list = async (tokens = "") => {
    const response = await app.request("http://localhost/api/knowledge-tree?workspaceId=personal&includeDeleted=1", {
      headers: { "X-User-Id": userId, "X-Folder-Unlock-Tokens": tokens },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    return await response.json() as { nodes: Array<{ id: string; parentId: string | null }>; passwordAuthorizedNotes: Array<{ noteId: string; folderIds: string[] }> };
  };
  assert.deepEqual((await list()).passwordAuthorizedNotes, []);
  assert.deepEqual((await list(unlock(inner))).passwordAuthorizedNotes, []);
  assert.deepEqual((await list(unlock(outer))).passwordAuthorizedNotes, []);
  const valid = [unlock(outer), unlock(inner)].join(",");
  const tree = await list(valid);
  assert.equal(tree.passwordAuthorizedNotes.length, 1);
  assert.equal(tree.passwordAuthorizedNotes[0].noteId, note.resourceId);
  assert.deepEqual(tree.passwordAuthorizedNotes[0].folderIds.slice().sort(), [outer.id, inner.id].sort());
  assert.equal(tree.nodes.find((node) => node.id === note.id)?.parentId, inner.id);

  assert.deepEqual((await list([unlock(outer, otherUserId), unlock(inner, userId, outer.resourceId), "invalid.signature"].join(","))).passwordAuthorizedNotes, []);
  assert.deepEqual((await list(unlock(other))).passwordAuthorizedNotes, []);

  db.prepare("UPDATE notebook_passwords SET passwordVersion = 4 WHERE notebookId = ?").run(outer.resourceId);
  assert.deepEqual((await list(valid)).passwordAuthorizedNotes, []);
  db.prepare("UPDATE knowledge_tree_nodes SET isDeleted = 1 WHERE id = ?").run(inner.id);
  assert.deepEqual((await list(valid)).passwordAuthorizedNotes, []);

  db.prepare("UPDATE notebook_passwords SET passwordVersion = 3 WHERE notebookId = ?").run(outer.resourceId);
  db.prepare("UPDATE knowledge_tree_nodes SET isDeleted = 0 WHERE id = ?").run(inner.id);
  for (let index = 1; index < 200; index++) {
    createKnowledgeChild({ actorUserId: userId, workspaceId: null, parentId: inner.id, nodeType: "note", title: `protected-${index}`, db });
  }
  const ordinary = createKnowledgeChild({ actorUserId: userId, workspaceId: null, parentId: null, nodeType: "note", title: "ordinary", db });
  const batch = await list(valid);
  assert.equal(batch.passwordAuthorizedNotes.length, 201);
  for (const entry of batch.passwordAuthorizedNotes) {
    assert.deepEqual(entry.folderIds.slice().sort(), entry.noteId === ordinary.resourceId ? [] : [outer.id, inner.id].sort());
  }
  assert.deepEqual((await list()).passwordAuthorizedNotes, [{ noteId: ordinary.resourceId, folderIds: [] }]);
});
