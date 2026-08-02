import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

const databaseUrl = process.env.TEST_PG_DATABASE_URL;
const skip = !databaseUrl;

test("PostgreSQL knowledge-tree runtime preserves access, metadata writes and response shapes", { skip }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  const runtime = await import("../src/db/runtime");

  await runtime.resetDatabaseRuntimeForTests();
  await runtime.initializeDatabase({
    env: {
      ...process.env,
      DB_DRIVER: "postgres",
      DATABASE_URL: databaseUrl,
    },
    dependencies: {
      createPostgresPool: () => pool,
      logger: { log: () => undefined, warn: () => undefined },
    },
  });

  const { runPostgresMigrations } = await import("../src/db/postgres/migrations");
  const applied = await runPostgresMigrations();
  assert(applied.some((migration) => migration.version === "0015_knowledge_tree_read_runtime"));

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ownerId = `pg-tree-owner-${suffix}`;
  const editorId = `pg-tree-editor-${suffix}`;
  const outsiderId = `pg-tree-outsider-${suffix}`;
  const workspaceId = `pg-tree-ws-${suffix}`;
  const notebookId = `pg-tree-nb-${suffix}`;
  const noteId = `pg-tree-note-${suffix}`;
  const orphanNodeId = `notebook:pg-tree-orphan-${suffix}`;
  const orphanResourceId = `pg-tree-orphan-${suffix}`;

  for (const userId of [ownerId, editorId, outsiderId]) {
    await pool.query(
      `INSERT INTO users (id, username, "passwordHash") VALUES ($1, $2, $3)`,
      [userId, userId, "hash"],
    );
  }
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, $2, $3)`,
    [workspaceId, "Knowledge Runtime Workspace", ownerId],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES ($1, $2, 'editor')`,
    [workspaceId, editorId],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name, "workspaceId", icon)
     VALUES ($1, $2, $3, $4, $5)`,
    [notebookId, ownerId, "Runtime Folder", workspaceId, "📁"],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, "workspaceId", "contentFormat", "isPinned", "isLocked"
     ) VALUES ($1, $2, $3, $4, $5, 'markdown', true, true)`,
    [noteId, ownerId, notebookId, "Runtime Note", workspaceId],
  );
  await pool.query(
    `INSERT INTO favorites ("userId", "noteId", "workspaceId") VALUES ($1, $2, $3)`,
    [ownerId, noteId, workspaceId],
  );
  await pool.query(
    `INSERT INTO notebook_passwords ("notebookId", "passwordHash") VALUES ($1, $2)`,
    [notebookId, "password-hash"],
  );
  await pool.query(
    `INSERT INTO knowledge_tree_nodes (
       id, "userId", "workspaceId", "scopeKey", "parentId", "nodeType", "resourceType",
       "resourceId", "sortOrder", "isExpanded", "isDeleted"
     ) VALUES ($1, $2, $3, $4, NULL, 'folder', 'notebook', $5, 999, true, false)`,
    [orphanNodeId, ownerId, workspaceId, `workspace:${workspaceId}`, orphanResourceId],
  );

  try {
    const { createKnowledgeTreeReadRepository } = await import(
      "../src/repositories/knowledgeTreeReadRepository"
    );
    const repository = createKnowledgeTreeReadRepository(
      runtime.getDatabaseAdapter(),
      "postgres",
    );

    const ownerNodes = await repository.list({ userId: ownerId, workspaceId });
    assert.equal(ownerNodes.length, 3);
    assert(ownerNodes.every((node) => node.access.rolePreset === "admin"));
    assert(ownerNodes.every((node) => node.access.source === "owner"));

    const ownerFolder = ownerNodes.find((node) => node.resourceId === notebookId);
    const ownerNote = ownerNodes.find((node) => node.resourceId === noteId);
    assert.equal(ownerFolder?.title, "Runtime Folder");
    assert.equal(ownerFolder?.icon, "📁");
    assert.equal(ownerFolder?.isPasswordProtected, 1);
    assert.equal(ownerFolder?.childCount, 1);
    assert.equal(ownerNote?.title, "Runtime Note");
    assert.equal(ownerNote?.contentFormat, "markdown");
    assert.equal(ownerNote?.isPinned, 1);
    assert.equal(ownerNote?.isLocked, 1);
    assert.equal(ownerNote?.isFavorite, 1);
    assert.equal(typeof ownerNote?.createdAt, "string");
    assert.equal(typeof ownerNote?.updatedAt, "string");

    const legacyEditorNodes = await repository.list({ userId: editorId, workspaceId });
    assert.equal(legacyEditorNodes.length, 3);
    assert(
      legacyEditorNodes.every(
        (node) => node.access.rolePreset === "editor" && node.access.source === "legacy",
      ),
    );

    await pool.query(
      `INSERT INTO knowledge_tree_acl ("nodeId", "userId", "rolePreset")
       VALUES ($1, $2, 'readonly')`,
      [`notebook:${notebookId}`, editorId],
    );

    const explicitNodes = await repository.list({ userId: editorId, workspaceId });
    const explicitFolder = explicitNodes.find((node) => node.resourceId === notebookId);
    const inheritedNote = explicitNodes.find((node) => node.resourceId === noteId);
    assert.equal(explicitFolder?.access.rolePreset, "readonly");
    assert.equal(explicitFolder?.access.source, "direct");
    assert.equal(explicitFolder?.access.sourceNodeId, `notebook:${notebookId}`);
    assert.equal(inheritedNote?.access.rolePreset, "readonly");
    assert.equal(inheritedNote?.access.source, "inherited");
    assert.equal(inheritedNote?.access.sourceNodeId, `notebook:${notebookId}`);
    assert.equal(inheritedNote?.access.capabilities.canEdit, false);

    assert.deepEqual(
      await repository.list({ userId: outsiderId, workspaceId }),
      [],
    );

    const { default: createKnowledgeTreeRuntimeRouter } = await import(
      "../src/routes/knowledge-tree-runtime"
    );
    const app = new Hono();
    app.route(
      "/api/knowledge-tree",
      createKnowledgeTreeRuntimeRouter(runtime.getDatabaseAdapter(), "postgres"),
    );

    const response = await app.request(
      `/api/knowledge-tree?workspaceId=${encodeURIComponent(workspaceId)}`,
      { headers: { "X-User-Id": editorId } },
    );
    assert.equal(response.status, 200);
    const payload = await response.json() as { nodes: Array<{ resourceId: string }> };
    assert.deepEqual(
      payload.nodes.map((node) => node.resourceId).sort(),
      [notebookId, noteId, orphanResourceId].sort(),
    );

    const folderPatch = await app.request(
      `/api/knowledge-tree/nodes/notebook:${notebookId}?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-User-Id": ownerId },
        body: JSON.stringify({ title: "Renamed Runtime Folder", isExpanded: false }),
      },
    );
    assert.equal(folderPatch.status, 200);
    const folderPatchPayload = await folderPatch.json() as { title: string; isExpanded: number };
    assert.equal(folderPatchPayload.title, "Renamed Runtime Folder");
    assert.equal(folderPatchPayload.isExpanded, 0);

    const storedFolder = await pool.query<{
      name: string;
      isExpanded: boolean;
      treeExpanded: boolean;
    }>(
      `SELECT nb.name, nb."isExpanded" AS "isExpanded", node."isExpanded" AS "treeExpanded"
         FROM notebooks nb
         JOIN knowledge_tree_nodes node
           ON node."resourceType" = 'notebook' AND node."resourceId" = nb.id
        WHERE nb.id = $1`,
      [notebookId],
    );
    assert.equal(storedFolder.rows[0]?.name, "Renamed Runtime Folder");
    assert.equal(storedFolder.rows[0]?.isExpanded, false);
    assert.equal(storedFolder.rows[0]?.treeExpanded, false);

    const invalidPatch = await app.request(
      `/api/knowledge-tree/nodes/notebook:${notebookId}?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-User-Id": ownerId },
        body: JSON.stringify({ title: "   ", isExpanded: true }),
      },
    );
    assert.equal(invalidPatch.status, 400);
    const invalidPayload = await invalidPatch.json() as { code: string };
    assert.equal(invalidPayload.code, "KNOWLEDGE_TITLE_REQUIRED");
    const unchangedExpansion = await pool.query<{ isExpanded: boolean }>(
      `SELECT "isExpanded" AS "isExpanded" FROM knowledge_tree_nodes WHERE id = $1`,
      [`notebook:${notebookId}`],
    );
    assert.equal(unchangedExpansion.rows[0]?.isExpanded, false);

    const notePatch = await app.request(
      `/api/knowledge-tree/nodes/note:${noteId}?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-User-Id": ownerId },
        body: JSON.stringify({ title: "Renamed Runtime Note" }),
      },
    );
    assert.equal(notePatch.status, 200);
    const notePatchPayload = await notePatch.json() as { title: string };
    assert.equal(notePatchPayload.title, "Renamed Runtime Note");
    const storedNote = await pool.query<{ title: string; version: number }>(
      `SELECT title, version FROM notes WHERE id = $1`,
      [noteId],
    );
    assert.equal(storedNote.rows[0]?.title, "Renamed Runtime Note");
    assert((storedNote.rows[0]?.version || 0) > 0);

    const forbiddenPatch = await app.request(
      `/api/knowledge-tree/nodes/note:${noteId}?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-User-Id": editorId },
        body: JSON.stringify({ title: "Forbidden Rename" }),
      },
    );
    assert.equal(forbiddenPatch.status, 403);
    const forbiddenPayload = await forbiddenPatch.json() as { code: string; required: string };
    assert.equal(forbiddenPayload.code, "KNOWLEDGE_CAPABILITY_FORBIDDEN");
    assert.equal(forbiddenPayload.required, "canEdit");

    const stalePatch = await app.request(
      `/api/knowledge-tree/nodes/${orphanNodeId}?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-User-Id": ownerId },
        body: JSON.stringify({ title: "Must Roll Back", isExpanded: false }),
      },
    );
    assert.equal(stalePatch.status, 409);
    const stalePayload = await stalePatch.json() as { code: string };
    assert.equal(stalePayload.code, "KNOWLEDGE_NODE_STALE");
    const orphanAfterFailure = await pool.query<{ isExpanded: boolean }>(
      `SELECT "isExpanded" AS "isExpanded" FROM knowledge_tree_nodes WHERE id = $1`,
      [orphanNodeId],
    );
    assert.equal(orphanAfterFailure.rows[0]?.isExpanded, true);
  } finally {
    await pool.query(`DELETE FROM knowledge_tree_nodes WHERE id = $1`, [orphanNodeId]);
    await pool.query(`DELETE FROM knowledge_tree_acl WHERE "userId" = $1`, [editorId]);
    await pool.query(`DELETE FROM favorites WHERE "noteId" = $1`, [noteId]);
    await pool.query(`DELETE FROM notebook_passwords WHERE "notebookId" = $1`, [notebookId]);
    await pool.query(`DELETE FROM notes WHERE id = $1`, [noteId]);
    await pool.query(`DELETE FROM notebooks WHERE id = $1`, [notebookId]);
    await pool.query(`DELETE FROM workspace_members WHERE "workspaceId" = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    await pool.query(
      `DELETE FROM users WHERE id = ANY($1::text[])`,
      [[ownerId, editorId, outsiderId]],
    );
    await runtime.resetDatabaseRuntimeForTests();
  }
});
