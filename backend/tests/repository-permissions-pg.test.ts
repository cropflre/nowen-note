import assert from "node:assert/strict";
import test from "node:test";

const databaseUrl = process.env.TEST_PG_DATABASE_URL;
const skip = !databaseUrl;

test("PG permission repositories use the runtime adapter", { skip }, async () => {
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
  const ownerId = `pg-permissions-owner-${suffix}`;
  const userA = `pg-permissions-a-${suffix}`;
  const userB = `pg-permissions-b-${suffix}`;
  const userC = `pg-permissions-c-${suffix}`;
  const workspaceOne = `pg-permissions-ws1-${suffix}`;
  const workspaceTwo = `pg-permissions-ws2-${suffix}`;
  const notebookId = `pg-permissions-nb-${suffix}`;
  const noteId = `pg-permissions-note-${suffix}`;
  const memberId = `pg-permissions-member-${suffix}`;

  for (const userId of [ownerId, userA, userB, userC]) {
    await pool.query(
      `INSERT INTO users (id, username, "passwordHash") VALUES ($1, $2, $3)`,
      [userId, userId, "hash"],
    );
  }
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, $2, $3), ($4, $5, $3)`,
    [workspaceOne, "Workspace One", ownerId, workspaceTwo, "Workspace Two"],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name, "workspaceId") VALUES ($1, $2, $3, $4)`,
    [notebookId, ownerId, "Permissions Notebook", workspaceOne],
  );
  await pool.query(
    `INSERT INTO notes (id, "userId", "notebookId", title, "workspaceId") VALUES ($1, $2, $3, $4, $5)`,
    [noteId, ownerId, notebookId, "Permissions Note", workspaceOne],
  );

  try {
    const { workspaceMembersRepository } = await import("../src/repositories/workspaceMembersRepository");
    await workspaceMembersRepository.createAsync(workspaceOne, userA, "viewer");
    await workspaceMembersRepository.createAsync(workspaceOne, userB, "editor");
    await workspaceMembersRepository.createAsync(workspaceTwo, userC, "viewer");

    assert.equal(await workspaceMembersRepository.countByWorkspaceAsync(workspaceOne), 2);
    assert.equal(await workspaceMembersRepository.countByUserAsync(userA), 1);
    assert.equal((await workspaceMembersRepository.getRoleAsync(workspaceOne, userB))?.role, "editor");
    assert.deepEqual(await workspaceMembersRepository.listCommonWorkspacesAsync(userA, userB), [workspaceOne]);

    const workspaceMembers = await workspaceMembersRepository.listByWorkspaceWithUserAsync(workspaceOne);
    assert.deepEqual(workspaceMembers.map((member) => member.userId), [userB, userA]);

    assert.equal(await workspaceMembersRepository.transferOwnershipAsync(userC, userB), 1);
    assert.deepEqual(
      (await workspaceMembersRepository.listWorkspaceIdsByUserAsync(userB)).sort(),
      [workspaceOne, workspaceTwo].sort(),
    );

    const { notebookMembersRepository } = await import("../src/repositories/notebookMembersRepository");
    await notebookMembersRepository.upsertAsync({
      id: memberId,
      notebookId,
      userId: userA,
      role: "editor",
      invitedBy: ownerId,
    });
    await notebookMembersRepository.upsertAsync({
      id: `${memberId}-ignored-on-conflict`,
      notebookId,
      userId: userA,
      role: "viewer",
      invitedBy: ownerId,
    });

    assert.equal((await notebookMembersRepository.getRoleAsync(notebookId, userA))?.role, "viewer");
    assert.equal((await notebookMembersRepository.listByNotebookAsync(notebookId)).length, 1);
    await notebookMembersRepository.removeAsync(notebookId, userA);
    assert.equal(await notebookMembersRepository.getRoleAsync(notebookId, userA), undefined);

    await notebookMembersRepository.upsertAsync({
      id: `${memberId}-reactivate`,
      notebookId,
      userId: userA,
      role: "editor",
      invitedBy: ownerId,
    });
    const reactivated = await notebookMembersRepository.getByNotebookAndUserAsync(notebookId, userA);
    assert.equal(reactivated?.status, "active");
    assert.equal(reactivated?.role, "editor");

    await pool.query(
      `INSERT INTO note_acl ("noteId", "userId", permission, "grantedBy")
       VALUES ($1, $2, 'edit', $4), ($1, $3, 'view', $4)`,
      [noteId, userA, userB, ownerId],
    );

    const { noteAclRepository } = await import("../src/repositories/noteAclRepository");
    assert.equal((await noteAclRepository.getPermissionAsync(noteId, userA))?.permission, "edit");
    assert.deepEqual(await noteAclRepository.listCommonNotesAsync(userA, userB), [noteId]);
    assert.equal(await noteAclRepository.transferOwnershipAsync(userA, userC), 1);
    await noteAclRepository.deleteByUserAndWorkspaceAsync(userC, workspaceOne);
    assert.equal(await noteAclRepository.getPermissionAsync(noteId, userC), undefined);
    await noteAclRepository.deleteByNoteAndUserAsync(noteId, userB);
    assert.equal(await noteAclRepository.getPermissionAsync(noteId, userB), undefined);
  } finally {
    await pool.query(`DELETE FROM note_acl WHERE "noteId" = $1`, [noteId]);
    await pool.query(`DELETE FROM notebook_members WHERE "notebookId" = $1`, [notebookId]);
    await pool.query(`DELETE FROM workspace_members WHERE "workspaceId" = ANY($1::text[])`, [[workspaceOne, workspaceTwo]]);
    await pool.query(`DELETE FROM notes WHERE id = $1`, [noteId]);
    await pool.query(`DELETE FROM notebooks WHERE id = $1`, [notebookId]);
    await pool.query(`DELETE FROM workspaces WHERE id = ANY($1::text[])`, [[workspaceOne, workspaceTwo]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[ownerId, userA, userB, userC]]);
    await runtime.resetDatabaseRuntimeForTests();
  }
});
