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
  parentId: string | null;
};

type EffectiveAccess = {
  rolePreset: string;
  source: string;
  sourceNodeId: string | null;
  capabilities: { canManageMembers: boolean; canEdit: boolean; canView: boolean };
};

type PermissionRow = {
  nodeId: string;
  userId: string;
  rolePreset: string;
  username: string;
  capabilities: Record<string, boolean>;
  effective?: EffectiveAccess;
};

async function responseJson<T>(response: Response, expectedStatus: number): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, expectedStatus, text);
  return JSON.parse(text) as T;
}

test("PostgreSQL knowledge-tree permission runtime is inherited, idempotent and atomic", { skip }, async () => {
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
  const ownerId = `pg-tree-perm-owner-${suffix}`;
  const adminId = `pg-tree-perm-admin-${suffix}`;
  const memberId = `pg-tree-perm-member-${suffix}`;
  const viewerId = `pg-tree-perm-viewer-${suffix}`;
  const outsiderId = `pg-tree-perm-outsider-${suffix}`;
  const rollbackId = `pg-tree-perm-rollback-${suffix}`;
  const workspaceId = `pg-tree-perm-ws-${suffix}`;
  const userIds = [ownerId, adminId, memberId, viewerId, outsiderId, rollbackId];

  for (const userId of userIds) {
    await pool.query(
      `INSERT INTO users (id, username, email, "passwordHash") VALUES ($1, $2, $3, $4)`,
      [userId, userId, `${userId}@example.test`, "hash"],
    );
  }
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, $2, $3)`,
    [workspaceId, "Knowledge Permission Workspace", ownerId],
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
    const { createKnowledgeTreePermissionMutationRepository } = await import(
      "../src/repositories/knowledgeTreePermissionMutationRepository"
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
    const setPermission = async (
      actorUserId: string,
      nodeId: string,
      subject: string,
      rolePreset: string,
      expectedStatus = 200,
    ) => responseJson<PermissionRow & { code?: string; effective?: EffectiveAccess }>(
      await app.request(
        `/api/knowledge-tree/nodes/${encodeURIComponent(nodeId)}/permissions?${workspaceQuery}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", "X-User-Id": actorUserId },
          body: JSON.stringify({ subject, rolePreset }),
        },
      ),
      expectedStatus,
    );
    const clearPermission = async (
      actorUserId: string,
      nodeId: string,
      targetUserId: string,
      expectedStatus = 200,
    ) => responseJson<{
      success?: true;
      removed?: boolean;
      code?: string;
      effective?: EffectiveAccess;
    }>(
      await app.request(
        `/api/knowledge-tree/nodes/${encodeURIComponent(nodeId)}/permissions/${encodeURIComponent(targetUserId)}?${workspaceQuery}`,
        { method: "DELETE", headers: { "X-User-Id": actorUserId } },
      ),
      expectedStatus,
    );
    const getPermissions = async (
      actorUserId: string,
      nodeId: string,
      expectedStatus = 200,
    ) => responseJson<{
      direct?: PermissionRow[];
      inheritsFromParent?: string | null;
      currentUserAccess?: EffectiveAccess;
      code?: string;
    }>(
      await app.request(
        `/api/knowledge-tree/nodes/${encodeURIComponent(nodeId)}/permissions?${workspaceQuery}`,
        { headers: { "X-User-Id": actorUserId } },
      ),
      expectedStatus,
    );

    const root = await createNode(ownerId, null, "folder", "Permission Root");
    const child = await createNode(ownerId, root.id, "folder", "Permission Child");
    const note = await createNode(ownerId, child.id, "markdown", "Permission Note");

    const viewerRead = await getPermissions(viewerId, root.id, 403);
    assert.equal(viewerRead.code, "KNOWLEDGE_CAPABILITY_FORBIDDEN");

    const adminGrant = await setPermission(ownerId, root.id, adminId, "admin");
    assert.equal(adminGrant.rolePreset, "admin");
    assert.equal(adminGrant.effective?.source, "direct");
    assert.equal(adminGrant.effective?.capabilities.canManageMembers, true);

    const inheritedAdmin = await getPermissions(adminId, child.id);
    assert.equal(inheritedAdmin.inheritsFromParent, root.id);
    assert.equal(inheritedAdmin.currentUserAccess?.source, "inherited");
    assert.equal(inheritedAdmin.currentUserAccess?.sourceNodeId, root.id);
    assert.equal(inheritedAdmin.currentUserAccess?.capabilities.canManageMembers, true);

    const inheritedGrant = await setPermission(ownerId, root.id, memberId, "editor");
    assert.equal(inheritedGrant.effective?.source, "direct");
    assert.equal(inheritedGrant.effective?.capabilities.canEdit, true);

    const directOverride = await setPermission(ownerId, child.id, memberId, "readonly");
    assert.equal(directOverride.effective?.source, "direct");
    assert.equal(directOverride.effective?.rolePreset, "readonly");
    assert.equal(directOverride.effective?.capabilities.canEdit, false);

    const historyAfterFirstSet = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM knowledge_tree_history
        WHERE "nodeId" = $1 AND action = 'permission_set' AND "targetUserId" = $2`,
      [child.id, memberId],
    );
    assert.equal(Number(historyAfterFirstSet.rows[0]?.count || 0), 1);

    const idempotentSet = await setPermission(ownerId, child.id, memberId, "readonly");
    assert.equal(idempotentSet.effective?.source, "direct");
    const historyAfterIdempotentSet = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM knowledge_tree_history
        WHERE "nodeId" = $1 AND action = 'permission_set' AND "targetUserId" = $2`,
      [child.id, memberId],
    );
    assert.equal(Number(historyAfterIdempotentSet.rows[0]?.count || 0), 1);

    const directRows = await getPermissions(ownerId, child.id);
    assert.equal(directRows.inheritsFromParent, root.id);
    assert.equal(directRows.direct?.length, 1);
    assert.equal(directRows.direct?.[0]?.username, memberId);
    assert.equal(directRows.direct?.[0]?.rolePreset, "readonly");

    const cleared = await clearPermission(ownerId, child.id, memberId);
    assert.equal(cleared.removed, true);
    assert.equal(cleared.effective?.source, "inherited");
    assert.equal(cleared.effective?.sourceNodeId, root.id);
    assert.equal(cleared.effective?.rolePreset, "editor");
    assert.equal(cleared.effective?.capabilities.canEdit, true);

    const idempotentClear = await clearPermission(ownerId, child.id, memberId);
    assert.equal(idempotentClear.removed, false);
    assert.equal(idempotentClear.effective?.source, "inherited");
    const clearHistory = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM knowledge_tree_history
        WHERE "nodeId" = $1 AND action = 'permission_clear' AND "targetUserId" = $2`,
      [child.id, memberId],
    );
    assert.equal(Number(clearHistory.rows[0]?.count || 0), 1);

    const memberManage = await getPermissions(memberId, child.id, 403);
    assert.equal(memberManage.code, "KNOWLEDGE_CAPABILITY_FORBIDDEN");

    const inheritedAdminSet = await setPermission(adminId, note.id, outsiderId, "maintainer");
    assert.equal(inheritedAdminSet.effective?.source, "direct");
    assert.equal(inheritedAdminSet.rolePreset, "maintainer");

    const selfLockout = await setPermission(adminId, root.id, adminId, "readonly", 409);
    assert.equal(selfLockout.code, "KNOWLEDGE_PERMISSION_SELF_LOCKOUT");

    const ownerImmutable = await setPermission(ownerId, root.id, ownerId, "readonly", 409);
    assert.equal(ownerImmutable.code, "KNOWLEDGE_PERMISSION_STALE");

    const invalidRole = await setPermission(ownerId, root.id, rollbackId, "invalid", 400);
    assert.equal(invalidRole.code, "KNOWLEDGE_ROLE_INVALID");

    const usernameResolution = await setPermission(ownerId, child.id, rollbackId, "editor");
    assert.equal(usernameResolution.userId, rollbackId);
    assert.equal(usernameResolution.username, rollbackId);

    const baseAdapter = runtime.getDatabaseAdapter();
    await setPermission(ownerId, child.id, outsiderId, "editor");
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
            `UPDATE knowledge_tree_acl
                SET "rolePreset" = 'maintainer',
                    "canDelete" = true,
                    "canMove" = true,
                    "updatedAt" = CURRENT_TIMESTAMP
              WHERE "nodeId" = ? AND "userId" = ?`,
            [child.id, outsiderId],
          );
        }
        return baseAdapter.executeStatements(statements);
      },
    };
    const staleRepository = createKnowledgeTreePermissionMutationRepository(staleAdapter, "postgres");
    await assert.rejects(
      staleRepository.setPermission({
        actorUserId: ownerId,
        workspaceId,
        nodeId: child.id,
        subject: outsiderId,
        rolePreset: "readonly",
      }),
      (error: unknown) => error instanceof KnowledgeTreeMutationError
        && error.code === "KNOWLEDGE_PERMISSION_STALE",
    );
    const staleRow = await pool.query<{ rolePreset: string }>(
      `SELECT "rolePreset" AS "rolePreset"
         FROM knowledge_tree_acl
        WHERE "nodeId" = $1 AND "userId" = $2`,
      [child.id, outsiderId],
    );
    assert.equal(staleRow.rows[0]?.rolePreset, "maintainer");

    let rollbackInjected = false;
    const rollbackAdapter: DatabaseAdapter = {
      queryOne: <T>(sql: string, params?: unknown[]) => baseAdapter.queryOne<T>(sql, params),
      queryMany: <T>(sql: string, params?: unknown[]) => baseAdapter.queryMany<T>(sql, params),
      execute: (sql: string, params?: unknown[]) => baseAdapter.execute(sql, params),
      executeBatch: (sql: string, paramsList: unknown[][]) => baseAdapter.executeBatch(sql, paramsList),
      executeStatements: async (statements) => {
        if (!rollbackInjected) {
          rollbackInjected = true;
          const injected = [...statements];
          injected.splice(3, 0, {
            sql: `INSERT INTO knowledge_permission_missing_table (id) VALUES (?)`,
            params: ["rollback"],
          });
          return baseAdapter.executeStatements(injected);
        }
        return baseAdapter.executeStatements(statements);
      },
    };
    const rollbackRepository = createKnowledgeTreePermissionMutationRepository(rollbackAdapter, "postgres");
    const historyBeforeRollback = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM knowledge_tree_history
        WHERE "nodeId" = $1 AND "targetUserId" = $2`,
      [child.id, rollbackId],
    );
    await assert.rejects(rollbackRepository.setPermission({
      actorUserId: ownerId,
      workspaceId,
      nodeId: child.id,
      subject: rollbackId,
      rolePreset: "admin",
    }));
    const rollbackRow = await pool.query<{ rolePreset: string }>(
      `SELECT "rolePreset" AS "rolePreset"
         FROM knowledge_tree_acl
        WHERE "nodeId" = $1 AND "userId" = $2`,
      [child.id, rollbackId],
    );
    assert.equal(rollbackRow.rows[0]?.rolePreset, "editor");
    const historyAfterRollback = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM knowledge_tree_history
        WHERE "nodeId" = $1 AND "targetUserId" = $2`,
      [child.id, rollbackId],
    );
    assert.equal(historyAfterRollback.rows[0]?.count, historyBeforeRollback.rows[0]?.count);

    const permissionHistory = await pool.query<{ action: string; count: string }>(
      `SELECT action, COUNT(*)::text AS count
         FROM knowledge_tree_history
        WHERE "actorUserId" = ANY($1::text[])
          AND action IN ('permission_set', 'permission_clear')
        GROUP BY action`,
      [[ownerId, adminId]],
    );
    assert(Number(permissionHistory.rows.find((row) => row.action === "permission_set")?.count || 0) >= 5);
    assert.equal(Number(permissionHistory.rows.find((row) => row.action === "permission_clear")?.count || 0), 1);
  } finally {
    await pool.query(`DELETE FROM notes WHERE "workspaceId" = $1`, [workspaceId]);
    await pool.query(`DELETE FROM notebooks WHERE "workspaceId" = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspace_members WHERE "workspaceId" = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [userIds]);
    await runtime.resetDatabaseRuntimeForTests();
  }
});
