import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-owner-permission-route-"));
process.env.DB_PATH = path.join(tempDir, "owner-permission-route.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("personal owner can revoke and deny members through the guarded permission API after sharing", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { Hono } = await import("hono");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const { enforceKnowledgePermissionPolicies } = await import("../src/middleware/knowledgePermissionPolicyGuard.js");
  const { default: knowledgeTreeRouter } = await import("../src/routes/knowledge-tree.js");

  closeDatabase = closeDb;
  const db = getDb();
  for (const userId of ["route-owner", "route-member", "route-stale-user"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')")
      .run(userId, userId);
  }

  const root = createKnowledgeChild({
    actorUserId: "route-owner",
    workspaceId: null,
    parentId: null,
    nodeType: "folder",
    title: "共享个人目录",
    db,
  });

  // Simulate the stale mirror that caused #783 while leaving the canonical notebook owner intact.
  db.prepare("UPDATE knowledge_tree_nodes SET userId = ? WHERE id = ?")
    .run("route-stale-user", root.id);

  const app = new Hono();
  app.use("/api/knowledge-tree/*", enforceKnowledgePermissionPolicies);
  app.route("/api/knowledge-tree", knowledgeTreeRouter);

  const ownerHeaders = {
    "Content-Type": "application/json",
    "X-User-Id": "route-owner",
  };

  const grant = await app.request(`http://localhost/api/knowledge-tree/nodes/${encodeURIComponent(root.id)}/permissions`, {
    method: "PUT",
    headers: ownerHeaders,
    body: JSON.stringify({ subject: "route-member", rolePreset: "readonly" }),
  });
  assert.equal(grant.status, 200);

  const permissionsAfterGrant = await app.request(
    `http://localhost/api/knowledge-tree/nodes/${encodeURIComponent(root.id)}/permissions`,
    { headers: { "X-User-Id": "route-owner" } },
  );
  assert.equal(permissionsAfterGrant.status, 200);
  const grantPayload = await permissionsAfterGrant.json() as any;
  assert.equal(grantPayload.currentUserAccess.source, "owner");
  assert.equal(grantPayload.currentUserAccess.capabilities.canManageMembers, true);

  const deny = await app.request(`http://localhost/api/knowledge-tree/nodes/${encodeURIComponent(root.id)}/permissions`, {
    method: "PUT",
    headers: ownerHeaders,
    body: JSON.stringify({ subject: "route-member", rolePreset: "deny" }),
  });
  assert.equal(deny.status, 200);
  const denyPayload = await deny.json() as any;
  assert.equal(denyPayload.rolePreset, "deny");
  assert.equal(denyPayload.effective.capabilities.canView, false);

  const remove = await app.request(
    `http://localhost/api/knowledge-tree/nodes/${encodeURIComponent(root.id)}/permissions/route-member`,
    { method: "DELETE", headers: { "X-User-Id": "route-owner" } },
  );
  assert.equal(remove.status, 200);
  const removePayload = await remove.json() as any;
  assert.equal(removePayload.success, true);
  assert.equal(removePayload.removed, true);

  // A non-admin collaborator still cannot call the same management endpoint directly.
  const forbidden = await app.request(`http://localhost/api/knowledge-tree/nodes/${encodeURIComponent(root.id)}/permissions`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": "route-member",
    },
    body: JSON.stringify({ subject: "route-stale-user", rolePreset: "deny" }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json() as any).code, "KNOWLEDGE_CAPABILITY_FORBIDDEN");
});
