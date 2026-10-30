import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-mcp-tree-p0-"));
process.env.DB_PATH = path.join(tmpDir, "tree.db");

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("MCP PAT tree CRUD enforces personal grants, previews and subtree revisions", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { initApiTokensTable } = await import("../src/lib/api-tokens.js");
  const { enforceApiTokenAccess } = await import("../src/middleware/api-token-resource-scope.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const { treeMutationRevision, treeMutationPreconditions } = await import("../../packages/nowen-mcp/src/tree-mutation.ts");
  const { default: treeRouter } = await import("../src/routes/knowledge-tree.js");
  const db = getDb();
  try {
    initApiTokensTable(db);
    db.exec(`
      INSERT INTO users (id, username, passwordHash) VALUES
        ('mcp-owner', 'mcp-owner', 'hash'), ('mcp-other', 'mcp-other', 'hash');
      INSERT INTO api_tokens (id, userId, name, tokenHash, scopes, resourceMode)
      VALUES ('mcp-tree-token', 'mcp-owner', 'Tree', 'test',
        '["notebooks:read","notebooks:write","notes:read","notes:write"]', 'restricted');
    `);
    const root = createKnowledgeChild({
      actorUserId: "mcp-owner", workspaceId: null, parentId: null, nodeType: "folder", title: "Allowed", db,
    });
    const denied = createKnowledgeChild({
      actorUserId: "mcp-owner", workspaceId: null, parentId: null, nodeType: "folder", title: "Denied", db,
    });
    const child = createKnowledgeChild({
      actorUserId: "mcp-owner", workspaceId: null, parentId: root.id, nodeType: "folder", title: "Child", db,
    });
    const note = createKnowledgeChild({
      actorUserId: "mcp-owner", workspaceId: null, parentId: child.id, nodeType: "markdown", title: "Important", db,
    });
    const other = createKnowledgeChild({
      actorUserId: "mcp-other", workspaceId: null, parentId: null, nodeType: "folder", title: "Other", db,
    });

    db.prepare(`
      INSERT INTO api_token_resources
        (id, tokenId, resourceType, resourceId, permission, includeDescendants)
      VALUES ('mcp-grant', 'mcp-tree-token', 'notebook', ?, 'write', 1)
    `).run(root.resourceId);

    const app = new Hono();
    app.use("/api/*", async (c, next) => {
      c.req.raw.headers.set("X-Auth-Mode", "api-token");
      c.req.raw.headers.set("X-User-Id", "mcp-owner");
      c.req.raw.headers.set("X-Api-Token-Id", "mcp-tree-token");
      c.req.raw.headers.set("X-Api-Resource-Mode", "restricted");
      c.req.raw.headers.set("X-Api-Scopes", "notebooks:read,notebooks:write,notes:read,notes:write");
      await next();
    });
    app.use("/api/*", enforceApiTokenAccess);
    app.route("/api/knowledge-tree/", treeRouter);

    const tree = async () => {
      const r = await app.request("/api/knowledge-tree/?workspaceId=personal&includeDeleted=1");
      assert.equal(r.status, 200, await r.clone().text());
      return (await r.json() as any).nodes as any[];
    };
    const preview = async (id: string, subtree = false) => {
      const nodes = await tree();
      const node = nodes.find((entry) => entry.id === id);
      assert.ok(node, `node must be visible to authorized PAT: ${id}; tree=${nodes.map((entry) => `${entry.id}:${entry.isDeleted}`).join(",")}`);
      return {
        ...treeMutationPreconditions(node,
          subtree ? treeMutationRevision(nodes, id, true) : undefined),
      };
    };
    const send = (url: string, method: string, body: Record<string, unknown>) =>
      app.request(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    assert.deepEqual((await tree()).map((item) => item.id).sort(),
      [root.id, child.id, note.id].sort(), "restricted tree must hide denied and foreign roots");

    let response = await send("/api/knowledge-tree/nodes?workspaceId=personal", "POST", {
      parentId: root.id, title: "AI folder", nodeType: "folder", ...await preview(root.id),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const created = await response.json() as any;
    assert.equal(created.title, "AI folder");

    const renamePreview = await preview(note.id);
    response = await send(`/api/knowledge-tree/nodes/${encodeURIComponent(note.id)}?workspaceId=personal`, "PATCH", {
      title: "Safer title", ...renamePreview, expectedTitle: "stale",
    });
    assert.equal(response.status, 409, "stale rename precondition must be rejected");
    response = await send(`/api/knowledge-tree/nodes/${encodeURIComponent(note.id)}?workspaceId=personal`, "PATCH", {
      title: "Safer title", ...renamePreview,
    });
    assert.equal(response.status, 200, await response.clone().text());

    const stale = await preview(child.id, true);
    db.prepare("UPDATE notes SET title='Changed after preview' WHERE id=?").run(note.resourceId);
    response = await send(`/api/knowledge-tree/nodes/${encodeURIComponent(child.id)}?workspaceId=personal&mode=subtree`, "DELETE", stale);
    assert.equal(response.status, 409, "a nested change must invalidate delete preview");

    response = await send(`/api/knowledge-tree/nodes/${encodeURIComponent(child.id)}?workspaceId=personal&mode=subtree`, "DELETE", await preview(child.id, true));
    assert.equal(response.status, 200, await response.clone().text());

    response = await send(`/api/knowledge-tree/nodes/${encodeURIComponent(child.id)}/restore?workspaceId=personal`, "POST", {
      includeSubtree: true, ...await preview(child.id, true),
    });
    assert.equal(response.status, 200, await response.clone().text());

    response = await send(`/api/knowledge-tree/nodes/${encodeURIComponent(note.id)}/move?workspaceId=personal`, "PUT", {
      parentId: denied.id, ...await preview(note.id, true),
    });
    assert.equal(response.status, 403, "destination notebook without grant must be rejected");

    response = await send(`/api/knowledge-tree/nodes/${encodeURIComponent(other.id)}?workspaceId=personal`, "PATCH", {
      title: "Hijack", ...await preview(root.id),
    });
    assert.equal(response.status, 403, "foreign personal node must be rejected");

    response = await send("/api/knowledge-tree/batch/delete?workspaceId=personal", "POST", { nodeIds: [root.id] });
    assert.equal(response.status, 403, "batch delete remains blocked for PAT");

    const live = await tree();
    assert.ok(live.some((item) => item.id === child.id && !item.isDeleted));
  } finally {
    closeDb();
  }
});
