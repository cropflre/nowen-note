import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

test("locked folder notes stay hidden from note lists, direct reads and search until unlocked", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const [
    { getDb },
    { createKnowledgeChild },
    { wrapKnowledgeRoute },
    { signFolderUnlockToken },
  ] = await Promise.all([
    import("../src/db/schema.js"),
    import("../src/services/knowledgeTree.js"),
    import("../src/runtime/knowledge-tree.js"),
    import("../src/lib/knowledgeTreePasswordAccess.js"),
  ]);

  const db = getDb();
  const userId = "folder-password-visibility-owner";
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(userId, userId, "hash");

  const folder = createKnowledgeChild({
    actorUserId: userId,
    workspaceId: null,
    parentId: null,
    nodeType: "folder",
    title: "加密目录",
    db,
  });
  const note = createKnowledgeChild({
    actorUserId: userId,
    workspaceId: null,
    parentId: folder.id,
    nodeType: "note",
    title: "加密笔记",
    db,
  });
  db.prepare(`
    INSERT INTO notebook_passwords (notebookId, passwordHash, passwordVersion)
    VALUES (?, ?, ?)
  `).run(folder.resourceId, "unused-hash", 3);

  const noteRoutes = new Hono();
  noteRoutes.get("/", (c) => c.json([{ id: note.resourceId, title: "加密笔记" }]));
  noteRoutes.get("/:id", (c) => c.json({ id: c.req.param("id"), title: "加密笔记" }));
  const searchRoutes = new Hono();
  searchRoutes.get("/", (c) => c.json([{ id: note.resourceId, title: "加密笔记" }]));

  const app = new Hono();
  app.route("/api/notes", wrapKnowledgeRoute("/api/notes", noteRoutes));
  app.route("/api/search", wrapKnowledgeRoute("/api/search", searchRoutes));

  const lockedHeaders = { "X-User-Id": userId };
  const lockedList = await app.request("http://localhost/api/notes", { headers: lockedHeaders });
  assert.equal(lockedList.status, 200);
  assert.deepEqual(await lockedList.json(), []);

  const lockedDirect = await app.request(`http://localhost/api/notes/${note.resourceId}`, {
    headers: lockedHeaders,
  });
  assert.equal(lockedDirect.status, 404);

  const lockedSearch = await app.request("http://localhost/api/search?q=加密", { headers: lockedHeaders });
  assert.equal(lockedSearch.status, 200);
  assert.deepEqual(await lockedSearch.json(), []);

  const unlockToken = signFolderUnlockToken({
    userId,
    nodeId: folder.id,
    notebookId: folder.resourceId,
    passwordVersion: 3,
  });
  const unlockedHeaders = {
    "X-User-Id": userId,
    "X-Folder-Unlock-Tokens": unlockToken,
  };

  const unlockedList = await app.request("http://localhost/api/notes", { headers: unlockedHeaders });
  assert.deepEqual(await unlockedList.json(), [{ id: note.resourceId, title: "加密笔记" }]);

  const unlockedDirect = await app.request(`http://localhost/api/notes/${note.resourceId}`, {
    headers: unlockedHeaders,
  });
  assert.equal(unlockedDirect.status, 200);

  const unlockedSearch = await app.request("http://localhost/api/search?q=加密", {
    headers: unlockedHeaders,
  });
  assert.deepEqual(await unlockedSearch.json(), [{ id: note.resourceId, title: "加密笔记" }]);
});
