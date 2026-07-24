import assert from "node:assert/strict";
import test from "node:test";

const databaseUrl = process.env.TEST_PG_DATABASE_URL;
const skip = !databaseUrl;

test("PG API token resource scopes use runtime transactions and ACL precedence", { skip }, async () => {
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
  const ownerId = `pg-token-resource-owner-${suffix}`;
  const memberId = `pg-token-resource-member-${suffix}`;
  const workspaceId = `pg-token-resource-ws-${suffix}`;
  const ownerNotebookId = `pg-token-resource-owner-nb-${suffix}`;
  const readNotebookId = `pg-token-resource-read-nb-${suffix}`;
  const deniedNotebookId = `pg-token-resource-denied-nb-${suffix}`;
  const tokenId = `pg-token-resource-token-${suffix}`;

  for (const userId of [ownerId, memberId]) {
    await pool.query(
      `INSERT INTO users (id, username, "passwordHash") VALUES ($1, $2, $3)`,
      [userId, userId, "hash"],
    );
  }

  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, $2, $3)`,
    [workspaceId, "Token Resource Workspace", ownerId],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role)
     VALUES ($1, $2, 'editor')`,
    [workspaceId, memberId],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name, "workspaceId", "sortOrder")
     VALUES
       ($1, $4, 'Owner Notebook', $5, 1),
       ($2, $4, 'Read Notebook', $5, 2),
       ($3, $4, 'Denied Notebook', $5, 3)`,
    [ownerNotebookId, readNotebookId, deniedNotebookId, ownerId, workspaceId],
  );
  await pool.query(
    `INSERT INTO notebook_members
       (id, "notebookId", "userId", role, status, "invitedBy")
     VALUES
       ($1, $2, $3, 'viewer', 'active', $4),
       ($5, $6, $3, 'none', 'active', $4)`,
    [
      `pg-token-resource-member-read-${suffix}`,
      readNotebookId,
      memberId,
      ownerId,
      `pg-token-resource-member-deny-${suffix}`,
      deniedNotebookId,
    ],
  );

  try {
    const { apiTokenResourcesRepository } = await import(
      "../src/repositories/apiTokenResourcesRepository"
    );

    const options = await apiTokenResourcesRepository.listAuthorizedNotebookOptionsAsync(memberId);
    const byId = new Map(options.map((option) => [option.id, option]));
    assert.equal(byId.get(ownerNotebookId)?.canWrite, true);
    assert.equal(byId.get(readNotebookId)?.permission, "read");
    assert.equal(byId.get(readNotebookId)?.canWrite, false);
    assert.equal(byId.has(deniedNotebookId), false);

    await apiTokenResourcesRepository.createTokenAsync({
      id: tokenId,
      userId: memberId,
      name: "Scoped token",
      tokenHash: `hash-${suffix}`,
      scopes: ["notes:read"],
      expiresAt: null,
      resourceMode: "restricted",
      resources: [
        {
          id: `pg-token-resource-row-owner-${suffix}`,
          notebookId: ownerNotebookId,
          permission: "write",
          includeDescendants: false,
        },
        {
          id: `pg-token-resource-row-read-${suffix}`,
          notebookId: readNotebookId,
          permission: "read",
          includeDescendants: true,
        },
      ],
    });

    const tokens = await apiTokenResourcesRepository.listTokensByUserAsync(memberId);
    const token = tokens.find((item) => item.id === tokenId);
    assert.equal(token?.resourceMode, "restricted");
    assert.equal(typeof token?.createdAt, "string");

    const createdResources = await apiTokenResourcesRepository.listResourcesByTokenAsync(tokenId);
    assert.deepEqual(
      createdResources.map((resource) => ({
        notebookId: resource.notebookId,
        permission: resource.permission,
        includeDescendants: resource.includeDescendants,
      })),
      [
        {
          notebookId: ownerNotebookId,
          permission: "write",
          includeDescendants: false,
        },
        {
          notebookId: readNotebookId,
          permission: "read",
          includeDescendants: true,
        },
      ],
    );

    await apiTokenResourcesRepository.updateTokenResourcesAsync({
      tokenId,
      userId: memberId,
      resourceMode: "restricted",
      resources: [{
        id: `pg-token-resource-row-updated-${suffix}`,
        notebookId: readNotebookId,
        permission: "read",
        includeDescendants: false,
      }],
    });

    assert.deepEqual(
      (await apiTokenResourcesRepository.listResourcesByTokenAsync(tokenId)).map((resource) => ({
        notebookId: resource.notebookId,
        permission: resource.permission,
        includeDescendants: resource.includeDescendants,
      })),
      [{
        notebookId: readNotebookId,
        permission: "read",
        includeDescendants: false,
      }],
    );

    await assert.rejects(
      apiTokenResourcesRepository.updateTokenResourcesAsync({
        tokenId,
        userId: memberId,
        resourceMode: "unrestricted",
        resources: [{
          id: `pg-token-resource-row-invalid-${suffix}`,
          notebookId: ownerNotebookId,
          permission: "admin" as any,
          includeDescendants: false,
        }],
      }),
    );

    const afterRollback = await apiTokenResourcesRepository.listTokensByUserAsync(memberId);
    assert.equal(afterRollback.find((item) => item.id === tokenId)?.resourceMode, "restricted");
    assert.deepEqual(
      (await apiTokenResourcesRepository.listResourcesByTokenAsync(tokenId)).map((resource) => resource.notebookId),
      [readNotebookId],
    );
  } finally {
    await pool.query(`DELETE FROM api_tokens WHERE id = $1`, [tokenId]);
    await pool.query(
      `DELETE FROM notebook_members WHERE "notebookId" = ANY($1::text[])`,
      [[ownerNotebookId, readNotebookId, deniedNotebookId]],
    );
    await pool.query(`DELETE FROM workspace_members WHERE "workspaceId" = $1`, [workspaceId]);
    await pool.query(
      `DELETE FROM notebooks WHERE id = ANY($1::text[])`,
      [[ownerNotebookId, readNotebookId, deniedNotebookId]],
    );
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[ownerId, memberId]]);
    await runtime.resetDatabaseRuntimeForTests();
  }
});
