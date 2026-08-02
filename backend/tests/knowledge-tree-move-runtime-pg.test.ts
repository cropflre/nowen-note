import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import type { DatabaseAdapter } from "../src/db/adapters/types";
import { KnowledgeTreeMutationError } from "../src/repositories/knowledgeTreeMutationRepository";

const databaseUrl = process.env.TEST_PG_DATABASE_URL;
const skip = !databaseUrl;

type RuntimeNode = {
  id: string;
  resourceId: string;
  resourceType: string;
  parentId: string | null;
  title: string;
  sortOrder: number;
};

async function responseJson<T>(response: Response, expectedStatus: number): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, expectedStatus, text);
  return JSON.parse(text) as T;
}

test("PostgreSQL knowledge-tree move and reorder runtime is atomic and permission-safe", { skip }, async () => {
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
  await runPostgresMigrations();

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ownerId = `pg-tree-move-owner-${suffix}`;
  const editorId = `pg-tree-move-editor-${suffix}`;
  const viewerId = `pg-tree-move-viewer-${suffix}`;
  const outsiderId = `pg-tree-move-outsider-${suffix}`;
  const workspaceId = `pg-tree-move-ws-${suffix}`;

  for (const userId of [ownerId, editorId, viewerId, outsiderId]) {
    await pool.query(
      `INSERT INTO users (id, username, "passwordHash") VALUES ($1, $2, $3)`,
      [userId, userId, "hash"],
    );
  }
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, $2, $3)`,
    [workspaceId, "Knowledge Move Workspace", ownerId],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role)
     VALUES ($1, $2, 'editor'), ($1, $3, 'viewer')`,
    [workspaceId, editorId, viewerId],
  );

  try {
    const { default: createKnowledgeTreeRuntimeRouter } = await import(
      "../src/routes/knowledge-tree-runtime"
    );
    const app = new Hono();
    app.route(
      "/api/knowledge-tree",
      createKnowledgeTreeRuntimeRouter(runtime.getDatabaseAdapter(), "postgres"),
    );

    const workspaceQuery = `workspaceId=${encodeURIComponent(workspaceId)}`;
    const createNode = async (
      actorUserId: string,
      parentId: string | null,
      nodeType: "folder" | "note" | "markdown" | "word",
      title: string,
    ): Promise<RuntimeNode> => responseJson<RuntimeNode>(
      await app.request(`/api/knowledge-tree/nodes?${workspaceQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": actorUserId },
        body: JSON.stringify({ parentId, nodeType, title }),
      }),
      201,
    );

    const folderA = await createNode(ownerId, null, "folder", "Move Folder A");
    const folderB = await createNode(ownerId, null, "folder", "Move Folder B");
    const childFolder = await createNode(ownerId, folderA.id, "folder", "Move Child Folder");
    const markdown = await createNode(ownerId, folderA.id, "markdown", "Movable Markdown");

    const movedNote = await responseJson<RuntimeNode>(
      await app.request(
        `/api/knowledge-tree/nodes/${encodeURIComponent(markdown.id)}/move?${workspaceQuery}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-User-Id": ownerId },
          body: JSON.stringify({ parentId: folderB.id, sortOrder: 7 }),
        },
      ),
      200,
    );
    assert.equal(movedNote.parentId, folderB.id);
    assert.equal(movedNote.sortOrder, 7);

    const storedNote = await pool.query<{
      notebookId: string;
      treeParentId: string;
      treeSortOrder: number;
    }>(
      `SELECT note."notebookId" AS "notebookId",
              node."parentId" AS "treeParentId",
              node."sortOrder" AS "treeSortOrder"
         FROM notes note
         JOIN knowledge_tree_nodes node
           ON node."resourceType" = 'note' AND node."resourceId" = note.id
        WHERE note.id = $1`,
      [markdown.resourceId],
    );
    assert.equal(storedNote.rows[0]?.notebookId, folderB.resourceId);
    assert.equal(storedNote.rows[0]?.treeParentId, folderB.id);
    assert.equal(storedNote.rows[0]?.treeSortOrder, 7);

    const movedFolder = await responseJson<RuntimeNode>(
      await app.request(
        `/api/knowledge-tree/nodes/${encodeURIComponent(childFolder.id)}/move?${workspaceQuery}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-User-Id": ownerId },
          body: JSON.stringify({ parentId: folderB.id, sortOrder: 3 }),
        },
      ),
      200,
    );
    assert.equal(movedFolder.parentId, folderB.id);

    const storedFolder = await pool.query<{ parentId: string; treeParentId: string }>(
      `SELECT notebook."parentId" AS "parentId", node."parentId" AS "treeParentId"
         FROM notebooks notebook
         JOIN knowledge_tree_nodes node
           ON node."resourceType" = 'notebook' AND node."resourceId" = notebook.id
        WHERE notebook.id = $1`,
      [childFolder.resourceId],
    );
    assert.equal(storedFolder.rows[0]?.parentId, folderB.resourceId);
    assert.equal(storedFolder.rows[0]?.treeParentId, folderB.id);

    const cyclePayload = await responseJson<{ code: string }>(
      await app.request(
        `/api/knowledge-tree/nodes/${encodeURIComponent(folderB.id)}/move?${workspaceQuery}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-User-Id": ownerId },
          body: JSON.stringify({ parentId: childFolder.id }),
        },
      ),
      400,
    );
    assert.equal(cyclePayload.code, "KNOWLEDGE_TREE_CYCLE");

    assert.deepEqual(
      await responseJson<{ success: true; updated: number }>(
        await app.request(`/api/knowledge-tree/reorder?${workspaceQuery}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-User-Id": ownerId },
          body: JSON.stringify({
            items: [
              { id: folderA.id, sortOrder: 12 },
              { id: folderB.id, sortOrder: 4 },
            ],
          }),
        }),
        200,
      ),
      { success: true, updated: 2 },
    );

    const sortedFolders = await pool.query<{
      id: string;
      treeSortOrder: number;
      notebookSortOrder: number;
    }>(
      `SELECT node.id, node."sortOrder" AS "treeSortOrder",
              notebook."sortOrder" AS "notebookSortOrder"
         FROM knowledge_tree_nodes node
         JOIN notebooks notebook ON notebook.id = node."resourceId"
        WHERE node.id = ANY($1::text[])
        ORDER BY node.id`,
      [[folderA.id, folderB.id]],
    );
    const folderASort = sortedFolders.rows.find((row) => row.id === folderA.id);
    const folderBSort = sortedFolders.rows.find((row) => row.id === folderB.id);
    assert.equal(folderASort?.treeSortOrder, 12);
    assert.equal(folderASort?.notebookSortOrder, 12);
    assert.equal(folderBSort?.treeSortOrder, 4);
    assert.equal(folderBSort?.notebookSortOrder, 4);

    const viewerPayload = await responseJson<{ code: string }>(
      await app.request(`/api/knowledge-tree/reorder?${workspaceQuery}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-User-Id": viewerId },
        body: JSON.stringify({ items: [{ id: folderA.id, sortOrder: 1 }] }),
      }),
      403,
    );
    assert.equal(viewerPayload.code, "KNOWLEDGE_CAPABILITY_FORBIDDEN");

    await pool.query(
      `INSERT INTO knowledge_tree_acl ("nodeId", "userId", "rolePreset")
       VALUES ($1, $2, 'readonly')`,
      [folderB.id, editorId],
    );
    const readonlyPayload = await responseJson<{ code: string }>(
      await app.request(
        `/api/knowledge-tree/nodes/${encodeURIComponent(markdown.id)}/move?${workspaceQuery}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-User-Id": editorId },
          body: JSON.stringify({ parentId: folderA.id }),
        },
      ),
      403,
    );
    assert.equal(readonlyPayload.code, "KNOWLEDGE_CAPABILITY_FORBIDDEN");

    const sharedRoot = await createNode(ownerId, null, "folder", "Shared Move Root");
    await createNode(ownerId, sharedRoot.id, "note", "Shared Move Child");
    await pool.query(
      `INSERT INTO knowledge_tree_acl (
         "nodeId", "userId", "rolePreset",
         "canView", "canComment", "canCreate", "canEdit", "canDelete", "canMove", "canDownload"
       ) VALUES ($1, $2, 'maintainer', true, true, true, true, true, true, true)`,
      [sharedRoot.id, outsiderId],
    );
    const sharedRootPayload = await responseJson<{ code: string }>(
      await app.request(
        `/api/knowledge-tree/nodes/${encodeURIComponent(sharedRoot.id)}/move?${workspaceQuery}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-User-Id": outsiderId },
          body: JSON.stringify({ parentId: null }),
        },
      ),
      403,
    );
    assert.equal(sharedRootPayload.code, "KNOWLEDGE_SHARED_ROOT_MOVE_FORBIDDEN");

    const baseAdapter = runtime.getDatabaseAdapter();
    const failingAdapter: DatabaseAdapter = {
      queryOne: <T>(sql: string, params?: unknown[]) => baseAdapter.queryOne<T>(sql, params),
      queryMany: <T>(sql: string, params?: unknown[]) => baseAdapter.queryMany<T>(sql, params),
      execute: (sql: string, params?: unknown[]) => baseAdapter.execute(sql, params),
      executeBatch: (sql: string, paramsList: unknown[][]) => baseAdapter.executeBatch(sql, paramsList),
      executeStatements: (statements) => baseAdapter.executeStatements([
        ...statements,
        { sql: "INSERT INTO knowledge_tree_move_rollback_probe (id) VALUES (?)", params: [suffix] },
      ]),
    };
    const { createKnowledgeTreeStructureMutationRepository } = await import(
      "../src/repositories/knowledgeTreeStructureMutationRepository"
    );
    const failingRepository = createKnowledgeTreeStructureMutationRepository(
      failingAdapter,
      "postgres",
    );

    await assert.rejects(
      failingRepository.moveNode({
        actorUserId: ownerId,
        workspaceId,
        nodeId: markdown.id,
        parentId: folderA.id,
        sortOrder: 2,
      }),
    );
    const afterRollback = await pool.query<{ notebookId: string; treeParentId: string }>(
      `SELECT note."notebookId" AS "notebookId", node."parentId" AS "treeParentId"
         FROM notes note
         JOIN knowledge_tree_nodes node
           ON node."resourceType" = 'note' AND node."resourceId" = note.id
        WHERE note.id = $1`,
      [markdown.resourceId],
    );
    assert.equal(afterRollback.rows[0]?.notebookId, folderB.resourceId);
    assert.equal(afterRollback.rows[0]?.treeParentId, folderB.id);

    let staleInjected = false;
    const staleAdapter: DatabaseAdapter = {
      queryOne: <T>(sql: string, params?: unknown[]) => baseAdapter.queryOne<T>(sql, params),
      queryMany: <T>(sql: string, params?: unknown[]) => baseAdapter.queryMany<T>(sql, params),
      execute: (sql: string, params?: unknown[]) => baseAdapter.execute(sql, params),
      executeBatch: (sql: string, paramsList: unknown[][]) => baseAdapter.executeBatch(sql, paramsList),
      executeStatements: async (statements) => {
        if (!staleInjected) {
          staleInjected = true;
          await baseAdapter.execute(
            `UPDATE knowledge_tree_nodes SET "sortOrder" = "sortOrder" + 100 WHERE id = ?`,
            [markdown.id],
          );
        }
        return baseAdapter.executeStatements(statements);
      },
    };
    const staleRepository = createKnowledgeTreeStructureMutationRepository(staleAdapter, "postgres");
    await assert.rejects(
      staleRepository.moveNode({
        actorUserId: ownerId,
        workspaceId,
        nodeId: markdown.id,
        parentId: folderA.id,
      }),
      (error: unknown) => error instanceof KnowledgeTreeMutationError
        && error.code === "KNOWLEDGE_NODE_STALE",
    );

    const beforeFailedReorder = await pool.query<{ id: string; sortOrder: number }>(
      `SELECT id, "sortOrder" AS "sortOrder"
         FROM knowledge_tree_nodes
        WHERE id = ANY($1::text[])
        ORDER BY id`,
      [[folderA.id, folderB.id]],
    );
    await assert.rejects(
      failingRepository.reorderNodes({
        actorUserId: ownerId,
        workspaceId,
        items: [
          { id: folderA.id, sortOrder: 1 },
          { id: folderB.id, sortOrder: 2 },
        ],
      }),
    );
    const afterFailedReorder = await pool.query<{ id: string; sortOrder: number }>(
      `SELECT id, "sortOrder" AS "sortOrder"
         FROM knowledge_tree_nodes
        WHERE id = ANY($1::text[])
        ORDER BY id`,
      [[folderA.id, folderB.id]],
    );
    assert.deepEqual(afterFailedReorder.rows, beforeFailedReorder.rows);

    const history = await pool.query<{ action: string; count: string }>(
      `SELECT action, COUNT(*)::text AS count
         FROM knowledge_tree_history
        WHERE "nodeId" = ANY($1::text[])
          AND action IN ('move', 'reorder')
        GROUP BY action`,
      [[markdown.id, childFolder.id, folderA.id, folderB.id]],
    );
    assert(Number(history.rows.find((row) => row.action === "move")?.count || 0) >= 2);
    assert.equal(history.rows.find((row) => row.action === "reorder")?.count, "2");
  } finally {
    await pool.query(`DELETE FROM knowledge_tree_acl WHERE "userId" = ANY($1::text[])`, [
      [editorId, viewerId, outsiderId],
    ]);
    await pool.query(`DELETE FROM notes WHERE "workspaceId" = $1`, [workspaceId]);
    await pool.query(`DELETE FROM notebooks WHERE "workspaceId" = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspace_members WHERE "workspaceId" = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [
      [ownerId, editorId, viewerId, outsiderId],
    ]);
    await runtime.resetDatabaseRuntimeForTests();
  }
});
