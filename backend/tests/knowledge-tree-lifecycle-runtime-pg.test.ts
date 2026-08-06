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

test("PostgreSQL knowledge-tree delete, promote and restore runtime is atomic and permission-safe", { skip }, async () => {
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
  const ownerId = `pg-tree-life-owner-${suffix}`;
  const viewerId = `pg-tree-life-viewer-${suffix}`;
  const outsiderId = `pg-tree-life-outsider-${suffix}`;
  const workspaceId = `pg-tree-life-ws-${suffix}`;

  for (const userId of [ownerId, viewerId, outsiderId]) {
    await pool.query(
      `INSERT INTO users (id, username, "passwordHash") VALUES ($1, $2, $3)`,
      [userId, userId, "hash"],
    );
  }
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, $2, $3)`,
    [workspaceId, "Knowledge Lifecycle Workspace", ownerId],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role)
     VALUES ($1, $2, 'viewer')`,
    [workspaceId, viewerId],
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
    const removeNode = async (
      actorUserId: string,
      nodeId: string,
      mode: "subtree" | "promote",
      expectedStatus = 200,
    ) => responseJson<{
      success?: true;
      code?: string;
      affectedNodeIds?: string[];
      promotedNodeIds?: string[];
    }>(
      await app.request(
        `/api/knowledge-tree/nodes/${encodeURIComponent(nodeId)}?${workspaceQuery}&mode=${mode}`,
        { method: "DELETE", headers: { "X-User-Id": actorUserId } },
      ),
      expectedStatus,
    );
    const restoreNode = async (
      actorUserId: string,
      nodeId: string,
      includeSubtree: boolean,
      expectedStatus = 200,
    ) => responseJson<{ success?: true; code?: string; restoredNodeIds?: string[] }>(
      await app.request(
        `/api/knowledge-tree/nodes/${encodeURIComponent(nodeId)}/restore?${workspaceQuery}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-User-Id": actorUserId },
          body: JSON.stringify({ includeSubtree }),
        },
      ),
      expectedStatus,
    );

    const subtreeRoot = await createNode(ownerId, null, "folder", "Lifecycle Root");
    const subtreeFolder = await createNode(ownerId, subtreeRoot.id, "folder", "Lifecycle Child Folder");
    const subtreeNote = await createNode(ownerId, subtreeFolder.id, "markdown", "Lifecycle Child Note");

    const viewerDelete = await removeNode(viewerId, subtreeRoot.id, "subtree", 403);
    assert.equal(viewerDelete.code, "KNOWLEDGE_CAPABILITY_FORBIDDEN");

    const deletedSubtree = await removeNode(ownerId, subtreeRoot.id, "subtree");
    assert.deepEqual(
      new Set(deletedSubtree.affectedNodeIds),
      new Set([subtreeRoot.id, subtreeFolder.id, subtreeNote.id]),
    );
    assert.deepEqual(deletedSubtree.promotedNodeIds, []);

    const deletedRows = await pool.query<{
      id: string;
      isDeleted: boolean;
      resourceDeleted: boolean;
    }>(
      `SELECT node.id,
              node."isDeleted" AS "isDeleted",
              CASE
                WHEN node."resourceType" = 'note' THEN note."isTrashed"
                WHEN node."resourceType" = 'notebook' THEN notebook."isDeleted"
                ELSE node."isDeleted"
              END AS "resourceDeleted"
         FROM knowledge_tree_nodes node
         LEFT JOIN notes note
           ON node."resourceType" = 'note' AND note.id = node."resourceId"
         LEFT JOIN notebooks notebook
           ON node."resourceType" = 'notebook' AND notebook.id = node."resourceId"
        WHERE node.id = ANY($1::text[])
        ORDER BY node.id`,
      [[subtreeRoot.id, subtreeFolder.id, subtreeNote.id]],
    );
    assert.equal(deletedRows.rows.length, 3);
    assert(deletedRows.rows.every((row) => row.isDeleted && row.resourceDeleted));

    const restoredSubtree = await restoreNode(ownerId, subtreeRoot.id, true);
    assert.deepEqual(
      restoredSubtree.restoredNodeIds,
      [subtreeRoot.id, subtreeFolder.id, subtreeNote.id],
    );
    const restoredRows = await pool.query<{
      id: string;
      parentId: string | null;
      isDeleted: boolean;
      resourceDeleted: boolean;
    }>(
      `SELECT node.id,
              node."parentId" AS "parentId",
              node."isDeleted" AS "isDeleted",
              CASE
                WHEN node."resourceType" = 'note' THEN note."isTrashed"
                WHEN node."resourceType" = 'notebook' THEN notebook."isDeleted"
                ELSE node."isDeleted"
              END AS "resourceDeleted"
         FROM knowledge_tree_nodes node
         LEFT JOIN notes note
           ON node."resourceType" = 'note' AND note.id = node."resourceId"
         LEFT JOIN notebooks notebook
           ON node."resourceType" = 'notebook' AND notebook.id = node."resourceId"
        WHERE node.id = ANY($1::text[])
        ORDER BY node.id`,
      [[subtreeRoot.id, subtreeFolder.id, subtreeNote.id]],
    );
    assert(restoredRows.rows.every((row) => !row.isDeleted && !row.resourceDeleted));
    assert.equal(restoredRows.rows.find((row) => row.id === subtreeFolder.id)?.parentId, subtreeRoot.id);
    assert.equal(restoredRows.rows.find((row) => row.id === subtreeNote.id)?.parentId, subtreeFolder.id);

    const restoreHistoryBeforeRepeat = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM knowledge_tree_history
        WHERE "nodeId" = $1 AND action = 'restore'`,
      [subtreeRoot.id],
    );
    assert.deepEqual(await restoreNode(ownerId, subtreeRoot.id, true), {
      success: true,
      restoredNodeIds: [],
    });
    const restoreHistoryAfterRepeat = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM knowledge_tree_history
        WHERE "nodeId" = $1 AND action = 'restore'`,
      [subtreeRoot.id],
    );
    assert.equal(
      restoreHistoryAfterRepeat.rows[0]?.count,
      restoreHistoryBeforeRepeat.rows[0]?.count,
    );

    await removeNode(ownerId, subtreeRoot.id, "subtree");
    assert.deepEqual(await restoreNode(ownerId, subtreeRoot.id, false), {
      success: true,
      restoredNodeIds: [subtreeRoot.id],
    });
    const partialState = await pool.query<{ id: string; isDeleted: boolean }>(
      `SELECT id, "isDeleted" AS "isDeleted"
         FROM knowledge_tree_nodes
        WHERE id = ANY($1::text[])
        ORDER BY id`,
      [[subtreeRoot.id, subtreeFolder.id, subtreeNote.id]],
    );
    assert.equal(partialState.rows.find((row) => row.id === subtreeRoot.id)?.isDeleted, false);
    assert.equal(partialState.rows.find((row) => row.id === subtreeFolder.id)?.isDeleted, true);
    assert.equal(partialState.rows.find((row) => row.id === subtreeNote.id)?.isDeleted, true);
    await restoreNode(ownerId, subtreeFolder.id, true);

    const promoteParent = await createNode(ownerId, null, "folder", "Promote Parent");
    const promoteRoot = await createNode(ownerId, promoteParent.id, "folder", "Promote Root");
    const promotedFolder = await createNode(ownerId, promoteRoot.id, "folder", "Promoted Folder");
    const promotedNote = await createNode(ownerId, promoteRoot.id, "note", "Promoted Note");
    const promoted = await removeNode(ownerId, promoteRoot.id, "promote");
    assert.deepEqual(promoted.affectedNodeIds, [promoteRoot.id]);
    assert.deepEqual(promoted.promotedNodeIds, [promotedFolder.id, promotedNote.id]);

    const promotedRows = await pool.query<{
      id: string;
      treeParentId: string | null;
      physicalParentId: string | null;
      isDeleted: boolean;
    }>(
      `SELECT node.id,
              node."parentId" AS "treeParentId",
              CASE
                WHEN node."resourceType" = 'note' THEN note."notebookId"
                WHEN node."resourceType" = 'notebook' THEN notebook."parentId"
                ELSE NULL
              END AS "physicalParentId",
              node."isDeleted" AS "isDeleted"
         FROM knowledge_tree_nodes node
         LEFT JOIN notes note
           ON node."resourceType" = 'note' AND note.id = node."resourceId"
         LEFT JOIN notebooks notebook
           ON node."resourceType" = 'notebook' AND notebook.id = node."resourceId"
        WHERE node.id = ANY($1::text[])
        ORDER BY node.id`,
      [[promoteRoot.id, promotedFolder.id, promotedNote.id]],
    );
    assert.equal(promotedRows.rows.find((row) => row.id === promoteRoot.id)?.isDeleted, true);
    for (const nodeId of [promotedFolder.id, promotedNote.id]) {
      const row = promotedRows.rows.find((entry) => entry.id === nodeId);
      assert.equal(row?.treeParentId, promoteParent.id);
      assert.equal(row?.physicalParentId, promoteParent.resourceId);
      assert.equal(row?.isDeleted, false);
    }

    const topLevelFolder = await createNode(ownerId, null, "folder", "Top Level Promote Guard");
    const topLevelNote = await createNode(ownerId, topLevelFolder.id, "note", "Top Level Child Note");
    const topLevelPromote = await removeNode(ownerId, topLevelFolder.id, "promote", 400);
    assert.equal(topLevelPromote.code, "KNOWLEDGE_TREE_NOTE_CONTAINER_REQUIRED");
    const topLevelState = await pool.query<{ id: string; isDeleted: boolean; parentId: string | null }>(
      `SELECT id, "isDeleted" AS "isDeleted", "parentId" AS "parentId"
         FROM knowledge_tree_nodes
        WHERE id = ANY($1::text[])
        ORDER BY id`,
      [[topLevelFolder.id, topLevelNote.id]],
    );
    assert(topLevelState.rows.every((row) => !row.isDeleted));
    assert.equal(topLevelState.rows.find((row) => row.id === topLevelNote.id)?.parentId, topLevelFolder.id);

    const deletedParent = await createNode(ownerId, null, "folder", "Deleted Restore Parent");
    const deletedChild = await createNode(ownerId, deletedParent.id, "folder", "Deleted Restore Child");
    await removeNode(ownerId, deletedParent.id, "subtree");
    const deletedParentRestore = await restoreNode(ownerId, deletedChild.id, true, 409);
    assert.equal(deletedParentRestore.code, "KNOWLEDGE_RESTORE_PARENT_DELETED");
    await restoreNode(ownerId, deletedParent.id, true);

    const sharedRoot = await createNode(ownerId, null, "folder", "Shared Lifecycle Root");
    await createNode(ownerId, sharedRoot.id, "note", "Shared Lifecycle Child");
    await pool.query(
      `INSERT INTO knowledge_tree_acl (
         "nodeId", "userId", "rolePreset",
         "canView", "canComment", "canCreate", "canEdit", "canDelete", "canMove", "canDownload"
       ) VALUES ($1, $2, 'maintainer', true, true, true, true, true, true, true)`,
      [sharedRoot.id, outsiderId],
    );
    const sharedDelete = await removeNode(outsiderId, sharedRoot.id, "subtree", 403);
    assert.equal(sharedDelete.code, "KNOWLEDGE_SHARED_ROOT_DELETE_FORBIDDEN");
    await removeNode(ownerId, sharedRoot.id, "subtree");
    const sharedRestore = await restoreNode(outsiderId, sharedRoot.id, true, 403);
    assert.equal(sharedRestore.code, "KNOWLEDGE_SHARED_ROOT_RESTORE_FORBIDDEN");
    await restoreNode(ownerId, sharedRoot.id, true);

    const baseAdapter = runtime.getDatabaseAdapter();
    const { createKnowledgeTreeLifecycleMutationRepository } = await import(
      "../src/repositories/knowledgeTreeLifecycleMutationRepository"
    );

    const rollbackRoot = await createNode(ownerId, null, "folder", "Lifecycle Rollback Root");
    const rollbackNote = await createNode(ownerId, rollbackRoot.id, "note", "Lifecycle Rollback Note");
    const failingAdapter: DatabaseAdapter = {
      queryOne: <T>(sql: string, params?: unknown[]) => baseAdapter.queryOne<T>(sql, params),
      queryMany: <T>(sql: string, params?: unknown[]) => baseAdapter.queryMany<T>(sql, params),
      execute: (sql: string, params?: unknown[]) => baseAdapter.execute(sql, params),
      executeBatch: (sql: string, paramsList: unknown[][]) => baseAdapter.executeBatch(sql, paramsList),
      executeStatements: (statements) => baseAdapter.executeStatements([
        ...statements,
        { sql: "INSERT INTO knowledge_tree_lifecycle_rollback_probe (id) VALUES (?)", params: [suffix] },
      ]),
    };
    const failingRepository = createKnowledgeTreeLifecycleMutationRepository(
      failingAdapter,
      "postgres",
    );

    await assert.rejects(failingRepository.deleteNode({
      actorUserId: ownerId,
      workspaceId,
      nodeId: rollbackRoot.id,
      mode: "subtree",
    }));
    let rollbackState = await pool.query<{ id: string; isDeleted: boolean }>(
      `SELECT id, "isDeleted" AS "isDeleted"
         FROM knowledge_tree_nodes
        WHERE id = ANY($1::text[])
        ORDER BY id`,
      [[rollbackRoot.id, rollbackNote.id]],
    );
    assert(rollbackState.rows.every((row) => !row.isDeleted));

    const rollbackPromoteRoot = await createNode(ownerId, promoteParent.id, "folder", "Promote Rollback Root");
    const rollbackPromoteChild = await createNode(ownerId, rollbackPromoteRoot.id, "folder", "Promote Rollback Child");
    await assert.rejects(failingRepository.deleteNode({
      actorUserId: ownerId,
      workspaceId,
      nodeId: rollbackPromoteRoot.id,
      mode: "promote",
    }));
    const promoteRollbackState = await pool.query<{ id: string; parentId: string | null; isDeleted: boolean }>(
      `SELECT id, "parentId" AS "parentId", "isDeleted" AS "isDeleted"
         FROM knowledge_tree_nodes
        WHERE id = ANY($1::text[])
        ORDER BY id`,
      [[rollbackPromoteRoot.id, rollbackPromoteChild.id]],
    );
    assert.equal(promoteRollbackState.rows.find((row) => row.id === rollbackPromoteRoot.id)?.isDeleted, false);
    assert.equal(promoteRollbackState.rows.find((row) => row.id === rollbackPromoteChild.id)?.parentId, rollbackPromoteRoot.id);

    await removeNode(ownerId, rollbackRoot.id, "subtree");
    await assert.rejects(failingRepository.restoreNode({
      actorUserId: ownerId,
      workspaceId,
      nodeId: rollbackRoot.id,
      includeSubtree: true,
    }));
    rollbackState = await pool.query<{ id: string; isDeleted: boolean }>(
      `SELECT id, "isDeleted" AS "isDeleted"
         FROM knowledge_tree_nodes
        WHERE id = ANY($1::text[])
        ORDER BY id`,
      [[rollbackRoot.id, rollbackNote.id]],
    );
    assert(rollbackState.rows.every((row) => row.isDeleted));

    const staleRoot = await createNode(ownerId, null, "folder", "Lifecycle Stale Root");
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
            [staleRoot.id],
          );
        }
        return baseAdapter.executeStatements(statements);
      },
    };
    const staleRepository = createKnowledgeTreeLifecycleMutationRepository(staleAdapter, "postgres");
    await assert.rejects(
      staleRepository.deleteNode({
        actorUserId: ownerId,
        workspaceId,
        nodeId: staleRoot.id,
        mode: "subtree",
      }),
      (error: unknown) => error instanceof KnowledgeTreeMutationError
        && error.code === "KNOWLEDGE_NODE_STALE",
    );
    const staleState = await pool.query<{ isDeleted: boolean }>(
      `SELECT "isDeleted" AS "isDeleted" FROM knowledge_tree_nodes WHERE id = $1`,
      [staleRoot.id],
    );
    assert.equal(staleState.rows[0]?.isDeleted, false);

    const history = await pool.query<{ action: string; count: string }>(
      `SELECT action, COUNT(*)::text AS count
         FROM knowledge_tree_history
        WHERE "actorUserId" = $1
          AND action IN ('delete_subtree', 'delete_promote', 'restore')
        GROUP BY action`,
      [ownerId],
    );
    assert(Number(history.rows.find((row) => row.action === "delete_subtree")?.count || 0) >= 4);
    assert(Number(history.rows.find((row) => row.action === "delete_promote")?.count || 0) >= 1);
    assert(Number(history.rows.find((row) => row.action === "restore")?.count || 0) >= 4);
  } finally {
    await pool.query(`DELETE FROM knowledge_tree_acl WHERE "userId" = ANY($1::text[])`, [
      [viewerId, outsiderId],
    ]);
    await pool.query(`DELETE FROM notes WHERE "workspaceId" = $1`, [workspaceId]);
    await pool.query(`DELETE FROM notebooks WHERE "workspaceId" = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspace_members WHERE "workspaceId" = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [
      [ownerId, viewerId, outsiderId],
    ]);
    await runtime.resetDatabaseRuntimeForTests();
  }
});
