import assert from "node:assert/strict";
import test from "node:test";

const databaseUrl = process.env.TEST_PG_DATABASE_URL;
const skip = !databaseUrl;

test("PG round-trip permission mapping uses the Runtime Repository", { skip }, async () => {
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

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const workspaceId = `pg-permission-workspace-${suffix}`;
  const ownerId = `pg-permission-owner-${suffix}`;
  const mappedId = `pg-permission-mapped-${suffix}`;
  const adminId = `pg-permission-admin-${suffix}`;
  const sourceEditorId = `pg-permission-source-editor-${suffix}`;

  await pool.query(
    `INSERT INTO users (id, username, email, "passwordHash", "displayName", role)
     VALUES ($1, $2, $3, 'hash', $2, 'user'),
            ($4, $5, $6, 'hash', $5, 'user'),
            ($7, $8, NULL, 'hash', $8, 'admin'),
            ($9, $10, $11, 'hash', $10, 'user')`,
    [
      ownerId, `owner-${suffix}`, `owner-${suffix}@example.com`,
      mappedId, `mapped-${suffix}`, `mapped-${suffix}@example.com`,
      adminId, `admin-${suffix}`,
      sourceEditorId, `source-editor-${suffix}`, `source-editor-${suffix}@example.com`,
    ],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, description, "ownerId")
     VALUES ($1, $2, '', $3)`,
    [workspaceId, `Workspace ${suffix}`, ownerId],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'editor')`,
    [workspaceId, ownerId, sourceEditorId],
  );

  try {
    const service = await import("../src/services/roundTripPermissionMapping");

    const exported = await service.buildRoundTripPermissionsManifest(ownerId, workspaceId);
    assert.equal(exported.sourceWorkspace.id, workspaceId);
    assert.equal(exported.members.length, 2);
    assert.equal(exported.members.some((member) => member.role === "owner"), true);
    assert.equal(JSON.stringify(exported).includes("passwordHash"), false);

    const manifest = {
      format: "nowen-workspace-permissions",
      version: 1,
      exportedAt: new Date().toISOString(),
      sourceWorkspace: { id: "source", name: "Source" },
      members: [
        {
          sourceUserId: "source-owner",
          username: "old-owner",
          email: `mapped-${suffix}@example.com`,
          displayName: null,
          role: "owner",
        },
        {
          sourceUserId: "source-editor",
          username: `source-editor-${suffix}`,
          email: `source-editor-${suffix}@example.com`,
          displayName: null,
          role: "editor",
        },
      ],
    } as const;

    const suggestions = await service.previewRoundTripPermissionMappings(
      ownerId,
      workspaceId,
      manifest,
    );
    assert.equal(suggestions[0]?.match, "email");
    assert.equal(suggestions[0]?.suggestedTargetUserId, mappedId);
    assert.equal(suggestions[0]?.appliedRole, "admin");

    const applied = await service.applyRoundTripPermissionMappings({
      actorUserId: ownerId,
      workspaceId,
      manifest,
      mappings: [
        { sourceUserId: "source-owner", targetUserId: mappedId },
        { sourceUserId: "source-editor", targetUserId: ownerId },
      ],
    });
    assert.equal(applied.applied, 1);
    assert.equal(applied.skipped, 1);

    const mappedRole = await pool.query(
      `SELECT role FROM workspace_members WHERE "workspaceId" = $1 AND "userId" = $2`,
      [workspaceId, mappedId],
    );
    assert.equal(mappedRole.rows[0]?.role, "admin");
    const ownerRole = await pool.query(
      `SELECT role FROM workspace_members WHERE "workspaceId" = $1 AND "userId" = $2`,
      [workspaceId, ownerId],
    );
    assert.equal(ownerRole.rows[0]?.role, "owner");

    const adminPreview = await service.previewRoundTripPermissionMappings(
      adminId,
      workspaceId,
      manifest,
    );
    assert.equal(adminPreview.length, 2);
  } finally {
    await pool.query('DELETE FROM workspace_members WHERE "workspaceId" = $1', [workspaceId]);
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.query(
      "DELETE FROM users WHERE id = ANY($1::text[])",
      [[ownerId, mappedId, adminId, sourceEditorId]],
    );
    await runtime.resetDatabaseRuntimeForTests();
  }
});
