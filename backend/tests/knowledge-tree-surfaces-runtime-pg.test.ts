import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import bcrypt from "bcryptjs";
import { Hono } from "hono";

import type { DatabaseAdapter } from "../src/db/adapters/types";
import { verifyFolderUnlockToken } from "../src/lib/knowledgeTreePasswordAccess";
import { KnowledgeTreeMutationError } from "../src/repositories/knowledgeTreeMutationRepository";
import { createKnowledgeTreePasswordMutationRepository } from "../src/repositories/knowledgeTreePasswordMutationRepository";

const databaseUrl = process.env.TEST_PG_DATABASE_URL;
const skip = !databaseUrl;

type RuntimeNode = {
  id: string;
  resourceId: string;
  resourceType: string;
  parentId: string | null;
  title: string;
};

type SharedNode = RuntimeNode & {
  sharedRootId: string;
  sharedDepth: number;
  childCount: number;
};

async function responseJson<T>(response: Response, expectedStatus: number): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, expectedStatus, text);
  return JSON.parse(text) as T;
}

function passwordDigest(password: string): string {
  return createHash("sha256").update(password, "utf8").digest("base64");
}

test("PostgreSQL knowledge-tree shared, history and password surfaces are access-safe and atomic", { skip }, async () => {
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
  const ownerId = `pg-tree-surface-owner-${suffix}`;
  const viewerId = `pg-tree-surface-viewer-${suffix}`;
  const outsiderId = `pg-tree-surface-outsider-${suffix}`;

  for (const userId of [ownerId, viewerId, outsiderId]) {
    await pool.query(
      `INSERT INTO users (id, username, "passwordHash") VALUES ($1, $2, $3)`,
      [userId, userId, "hash"],
    );
  }

  try {
    const { default: createKnowledgeTreeRuntimeRouter } = await import(
      "../src/routes/knowledge-tree-runtime"
    );
    const { default: createKnowledgeTreeSurfacesRuntimeRouter } = await import(
      "../src/routes/knowledge-tree-surfaces-runtime"
    );
    const app = new Hono();
    const adapter = runtime.getDatabaseAdapter();
    app.route(
      "/api/knowledge-tree",
      createKnowledgeTreeRuntimeRouter(adapter, "postgres"),
    );
    app.route(
      "/api/knowledge-tree",
      createKnowledgeTreeSurfacesRuntimeRouter(adapter, "postgres"),
    );

    const personalQuery = "workspaceId=personal";
    const createNode = async (
      actorUserId: string,
      parentId: string | null,
      nodeType: "folder" | "note" | "markdown" | "word",
      title: string,
    ): Promise<RuntimeNode> => responseJson<RuntimeNode>(
      await app.request(`/api/knowledge-tree/nodes?${personalQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": actorUserId },
        body: JSON.stringify({ parentId, nodeType, title }),
      }),
      201,
    );
    const setPermission = async (
      nodeId: string,
      subject: string,
      rolePreset: "readonly" | "editor" | "maintainer" | "admin",
    ) => responseJson<{ effective: { rolePreset: string; source: string } }>(
      await app.request(
        `/api/knowledge-tree/nodes/${encodeURIComponent(nodeId)}/permissions?${personalQuery}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-User-Id": ownerId },
          body: JSON.stringify({ subject, rolePreset }),
        },
      ),
      200,
    );
    const clearPermission = async (nodeId: string, userId: string) => responseJson<{
      success: true;
      removed: boolean;
    }>(
      await app.request(
        `/api/knowledge-tree/nodes/${encodeURIComponent(nodeId)}/permissions/${encodeURIComponent(userId)}?${personalQuery}`,
        { method: "DELETE", headers: { "X-User-Id": ownerId } },
      ),
      200,
    );
    const listShared = async (actorUserId: string) => responseJson<{ nodes: SharedNode[] }>(
      await app.request(`/api/knowledge-tree/shared-with-me?${personalQuery}`, {
        headers: { "X-User-Id": actorUserId },
      }),
      200,
    );
    const setPassword = async (
      actorUserId: string,
      nodeId: string,
      input: { currentPassword?: string; newPassword: string },
      expectedStatus = 200,
    ) => responseJson<{ success?: true; code?: string; isPasswordProtected?: boolean }>(
      await app.request(`/api/knowledge-tree/nodes/${encodeURIComponent(nodeId)}/password`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-User-Id": actorUserId },
        body: JSON.stringify(input),
      }),
      expectedStatus,
    );
    const unlock = async (
      actorUserId: string,
      nodeId: string,
      password: string,
      expectedStatus = 200,
    ) => responseJson<{
      success?: true;
      code?: string;
      isPasswordProtected?: boolean;
      unlockToken?: string;
    }>(
      await app.request(`/api/knowledge-tree/nodes/${encodeURIComponent(nodeId)}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": actorUserId },
        body: JSON.stringify({ password }),
      }),
      expectedStatus,
    );

    const sharedRoot = await createNode(ownerId, null, "folder", "Shared Surface Root");
    const sharedChild = await createNode(ownerId, sharedRoot.id, "folder", "Shared Surface Child");
    const sharedNote = await createNode(ownerId, sharedChild.id, "markdown", "Shared Surface Note");
    const privateSibling = await createNode(ownerId, null, "folder", "Private Sibling");

    const emptyShared = await listShared(viewerId);
    assert.equal(emptyShared.nodes.length, 0);

    const permission = await setPermission(sharedRoot.id, viewerId, "readonly");
    assert.equal(permission.effective.rolePreset, "readonly");
    assert.equal(permission.effective.source, "direct");

    const shared = await listShared(viewerId);
    assert.deepEqual(
      new Set(shared.nodes.map((node) => node.id)),
      new Set([sharedRoot.id, sharedChild.id, sharedNote.id]),
    );
    assert(!shared.nodes.some((node) => node.id === privateSibling.id));
    assert.equal(shared.nodes.find((node) => node.id === sharedRoot.id)?.parentId, null);
    assert.equal(shared.nodes.find((node) => node.id === sharedChild.id)?.parentId, sharedRoot.id);
    assert.equal(shared.nodes.find((node) => node.id === sharedNote.id)?.parentId, sharedChild.id);
    assert.equal(shared.nodes.find((node) => node.id === sharedRoot.id)?.childCount, 1);
    assert(shared.nodes.every((node) => node.sharedRootId === sharedRoot.id));

    const viewerHistory = await responseJson<{ history: Array<{
      action: string;
      actorUsername: string | null;
      targetUsername: string | null;
      metadata: unknown;
    }> }>(
      await app.request(
        `/api/knowledge-tree/nodes/${encodeURIComponent(sharedRoot.id)}/history`,
        { headers: { "X-User-Id": viewerId } },
      ),
      200,
    );
    assert(viewerHistory.history.some((entry) => entry.action === "create"));
    assert(viewerHistory.history.some((entry) => entry.action === "permission_set"));
    assert(viewerHistory.history.some((entry) => entry.actorUsername === ownerId));
    assert(viewerHistory.history.some((entry) => entry.targetUsername === viewerId));

    const outsiderHistory = await responseJson<{ code: string }>(
      await app.request(
        `/api/knowledge-tree/nodes/${encodeURIComponent(sharedRoot.id)}/history`,
        { headers: { "X-User-Id": outsiderId } },
      ),
      403,
    );
    assert.equal(outsiderHistory.code, "KNOWLEDGE_CAPABILITY_FORBIDDEN");

    const viewerSetPassword = await setPassword(
      viewerId,
      sharedRoot.id,
      { newPassword: "surface-secret-1" },
      403,
    );
    assert.equal(viewerSetPassword.code, "KNOWLEDGE_CAPABILITY_FORBIDDEN");

    const firstSet = await setPassword(ownerId, sharedRoot.id, {
      newPassword: "surface-secret-1",
    });
    assert.equal(firstSet.success, true);
    const firstPasswordState = await pool.query<{
      passwordVersion: number;
      treeExpanded: boolean;
      notebookExpanded: boolean;
    }>(
      `SELECT password."passwordVersion" AS "passwordVersion",
              node."isExpanded" AS "treeExpanded",
              notebook."isExpanded" AS "notebookExpanded"
         FROM notebook_passwords password
         JOIN knowledge_tree_nodes node ON node.id = $1
         JOIN notebooks notebook ON notebook.id = password."notebookId"
        WHERE password."notebookId" = $2`,
      [sharedRoot.id, sharedRoot.resourceId],
    );
    assert.equal(firstPasswordState.rows[0]?.passwordVersion, 1);
    assert.equal(firstPasswordState.rows[0]?.treeExpanded, false);
    assert.equal(firstPasswordState.rows[0]?.notebookExpanded, false);

    const wrongUnlock = await unlock(viewerId, sharedRoot.id, "wrong-password", 403);
    assert.equal(wrongUnlock.code, "FOLDER_PASSWORD_INVALID");
    const firstUnlock = await unlock(viewerId, sharedRoot.id, "surface-secret-1");
    assert.equal(firstUnlock.isPasswordProtected, true);
    assert(firstUnlock.unlockToken);
    assert(verifyFolderUnlockToken(firstUnlock.unlockToken!, {
      userId: viewerId,
      nodeId: sharedRoot.id,
      notebookId: sharedRoot.resourceId,
      passwordVersion: 1,
    }));

    const wrongCurrent = await setPassword(ownerId, sharedRoot.id, {
      currentPassword: "wrong-current",
      newPassword: "surface-secret-2",
    }, 403);
    assert.equal(wrongCurrent.code, "FOLDER_PASSWORD_CURRENT_INVALID");

    await setPassword(ownerId, sharedRoot.id, {
      currentPassword: "surface-secret-1",
      newPassword: "surface-secret-2",
    });
    const secondPasswordState = await pool.query<{ passwordVersion: number }>(
      `SELECT "passwordVersion" AS "passwordVersion"
         FROM notebook_passwords WHERE "notebookId" = $1`,
      [sharedRoot.resourceId],
    );
    assert.equal(secondPasswordState.rows[0]?.passwordVersion, 2);
    assert(!verifyFolderUnlockToken(firstUnlock.unlockToken!, {
      userId: viewerId,
      nodeId: sharedRoot.id,
      notebookId: sharedRoot.resourceId,
      passwordVersion: 2,
    }));
    const secondUnlock = await unlock(viewerId, sharedRoot.id, "surface-secret-2");
    assert(verifyFolderUnlockToken(secondUnlock.unlockToken!, {
      userId: viewerId,
      nodeId: sharedRoot.id,
      notebookId: sharedRoot.resourceId,
      passwordVersion: 2,
    }));

    const unprotectedUnlock = await unlock(ownerId, privateSibling.id, "");
    assert.equal(unprotectedUnlock.isPasswordProtected, false);
    assert(verifyFolderUnlockToken(unprotectedUnlock.unlockToken!, {
      userId: ownerId,
      nodeId: privateSibling.id,
      notebookId: privateSibling.resourceId,
      passwordVersion: 0,
    }));

    const cleared = await clearPermission(sharedRoot.id, viewerId);
    assert.equal(cleared.removed, true);
    assert.equal((await listShared(viewerId)).nodes.length, 0);
    const revokedUnlock = await unlock(viewerId, sharedRoot.id, "surface-secret-2", 403);
    assert.equal(revokedUnlock.code, "KNOWLEDGE_CAPABILITY_FORBIDDEN");

    const rollbackFolder = await createNode(ownerId, null, "folder", "Password Rollback Folder");
    const baseAdapter = runtime.getDatabaseAdapter();
    const failingAdapter: DatabaseAdapter = {
      queryOne: <T>(sql: string, params?: unknown[]) => baseAdapter.queryOne<T>(sql, params),
      queryMany: <T>(sql: string, params?: unknown[]) => baseAdapter.queryMany<T>(sql, params),
      execute: (sql: string, params?: unknown[]) => baseAdapter.execute(sql, params),
      executeBatch: (sql: string, paramsList: unknown[][]) => baseAdapter.executeBatch(sql, paramsList),
      executeStatements: (statements) => baseAdapter.executeStatements([
        ...statements,
        { sql: "INSERT INTO knowledge_tree_password_rollback_probe (id) VALUES (?)", params: [suffix] },
      ]),
    };
    const failingRepository = createKnowledgeTreePasswordMutationRepository(failingAdapter, "postgres");
    const rollbackTarget = await failingRepository.readForUpdate({
      actorUserId: ownerId,
      nodeId: rollbackFolder.id,
    });
    await assert.rejects(failingRepository.setPassword({
      actorUserId: ownerId,
      nodeId: rollbackFolder.id,
      passwordHash: await bcrypt.hash(passwordDigest("rollback-secret"), 10),
      expectedPasswordHash: rollbackTarget.passwordHash,
      expectedPasswordVersion: rollbackTarget.passwordVersion,
    }));
    const rollbackState = await pool.query<{
      passwordCount: string;
      treeExpanded: boolean;
      notebookExpanded: boolean;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM notebook_passwords WHERE "notebookId" = $2) AS "passwordCount",
         node."isExpanded" AS "treeExpanded",
         notebook."isExpanded" AS "notebookExpanded"
       FROM knowledge_tree_nodes node
       JOIN notebooks notebook ON notebook.id = $2
       WHERE node.id = $1`,
      [rollbackFolder.id, rollbackFolder.resourceId],
    );
    assert.equal(rollbackState.rows[0]?.passwordCount, "0");
    assert.equal(rollbackState.rows[0]?.treeExpanded, true);
    assert.equal(rollbackState.rows[0]?.notebookExpanded, true);

    const staleFolder = await createNode(ownerId, null, "folder", "Password Stale Folder");
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
            `INSERT INTO notebook_passwords (
               "notebookId", "passwordHash", "passwordVersion"
             ) VALUES (?, ?, ?)`,
            [staleFolder.resourceId, "external-password-hash", 7],
          );
        }
        return baseAdapter.executeStatements(statements);
      },
    };
    const staleRepository = createKnowledgeTreePasswordMutationRepository(staleAdapter, "postgres");
    const staleTarget = await staleRepository.readForUpdate({
      actorUserId: ownerId,
      nodeId: staleFolder.id,
    });
    await assert.rejects(
      staleRepository.setPassword({
        actorUserId: ownerId,
        nodeId: staleFolder.id,
        passwordHash: await bcrypt.hash(passwordDigest("stale-secret"), 10),
        expectedPasswordHash: staleTarget.passwordHash,
        expectedPasswordVersion: staleTarget.passwordVersion,
      }),
      (error: unknown) => error instanceof KnowledgeTreeMutationError
        && error.code === "FOLDER_PASSWORD_STALE",
    );
    const staleState = await pool.query<{ passwordHash: string; passwordVersion: number }>(
      `SELECT "passwordHash" AS "passwordHash", "passwordVersion" AS "passwordVersion"
         FROM notebook_passwords WHERE "notebookId" = $1`,
      [staleFolder.resourceId],
    );
    assert.equal(staleState.rows[0]?.passwordHash, "external-password-hash");
    assert.equal(staleState.rows[0]?.passwordVersion, 7);
  } finally {
    await pool.query(`DELETE FROM notes WHERE "userId" = $1`, [ownerId]);
    await pool.query(`DELETE FROM notebooks WHERE "userId" = $1`, [ownerId]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [
      [ownerId, viewerId, outsiderId],
    ]);
    await runtime.resetDatabaseRuntimeForTests();
  }
});
