import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import bcrypt from "bcryptjs";
import { Hono } from "hono";

test("folder password can be removed only with the current password", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const [{ default: knowledgeTreeRouter }, { getDb }, { createKnowledgeChild }] = await Promise.all([
    import("../src/routes/knowledge-tree.js"),
    import("../src/db/schema.js"),
    import("../src/services/knowledgeTree.js"),
  ]);

  const db = getDb();
  const userId = "folder-password-owner";
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(userId, userId, "hash");
  const folder = createKnowledgeChild({
    actorUserId: userId,
    workspaceId: null,
    parentId: null,
    nodeType: "folder",
    title: "受保护文件夹",
    db,
  });

  const app = new Hono();
  app.route("/knowledge-tree", knowledgeTreeRouter);
  const headers = { "X-User-Id": userId, "Content-Type": "application/json" };

  const setResponse = await app.request(`/knowledge-tree/nodes/${folder.id}/password`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ newPassword: "folder-secret" }),
  });
  assert.equal(setResponse.status, 200, await setResponse.text());

  const wrongResponse = await app.request(`/knowledge-tree/nodes/${folder.id}/password`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ currentPassword: "wrong-secret" }),
  });
  assert.equal(wrongResponse.status, 403);
  assert.ok(db.prepare("SELECT 1 FROM notebook_passwords WHERE notebookId = ?").get(folder.resourceId));

  const newPassword = "new-folder-secret";
  const newPasswordDigest = createHash("sha256").update(newPassword, "utf8").digest("base64");
  const newPasswordHash = await bcrypt.hash(newPasswordDigest, 10);
  const originalCompare = bcrypt.compare;
  let releaseCompare!: () => void;
  let markCompareStarted!: () => void;
  const compareStarted = new Promise<void>((resolve) => { markCompareStarted = resolve; });
  const compareBlocked = new Promise<void>((resolve) => { releaseCompare = resolve; });
  (bcrypt as typeof bcrypt & { compare: typeof bcrypt.compare }).compare = async () => {
    markCompareStarted();
    await compareBlocked;
    return true;
  };

  let staleDeleteResponse: Response | undefined;
  try {
    const staleDeletePromise = app.request(`/knowledge-tree/nodes/${folder.id}/password`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ currentPassword: "folder-secret" }),
    });
    await compareStarted;
    db.prepare(`
      UPDATE notebook_passwords
      SET passwordHash = ?, passwordVersion = passwordVersion + 1
      WHERE notebookId = ?
    `).run(newPasswordHash, folder.resourceId);
    releaseCompare();
    staleDeleteResponse = await staleDeletePromise;
  } finally {
    releaseCompare();
    (bcrypt as typeof bcrypt & { compare: typeof bcrypt.compare }).compare = originalCompare;
  }
  assert.ok(staleDeleteResponse);
  assert.equal(staleDeleteResponse.status, 409);
  assert.equal((await staleDeleteResponse.json() as { code: string }).code, "FOLDER_PASSWORD_CHANGED");
  assert.ok(db.prepare("SELECT 1 FROM notebook_passwords WHERE notebookId = ?").get(folder.resourceId));

  const memberId = "folder-password-member";
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(memberId, memberId, "hash");
  const forbiddenResponse = await app.request(`/knowledge-tree/nodes/${folder.id}/password`, {
    method: "DELETE",
    headers: { "X-User-Id": memberId, "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword: newPassword }),
  });
  assert.equal(forbiddenResponse.status, 403);
  assert.equal((await forbiddenResponse.json() as { code: string }).code, "KNOWLEDGE_CAPABILITY_FORBIDDEN");

  const removeResponse = await app.request(`/knowledge-tree/nodes/${folder.id}/password`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ currentPassword: newPassword }),
  });
  const removeBody = await removeResponse.json();
  assert.equal(removeResponse.status, 200, JSON.stringify(removeBody));
  assert.deepEqual(removeBody, { success: true, isPasswordProtected: false });
  assert.equal(db.prepare("SELECT 1 FROM notebook_passwords WHERE notebookId = ?").get(folder.resourceId), undefined);
});
