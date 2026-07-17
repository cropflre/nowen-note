import assert from "node:assert/strict";
import test from "node:test";

const databaseUrl = process.env.TEST_PG_DATABASE_URL;
const skip = !databaseUrl;

test("PG share and session repositories preserve SQLite-facing shapes", { skip }, async () => {
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
  const ownerId = `pg-access-owner-${suffix}`;
  const memberId = `pg-access-member-${suffix}`;
  const workspaceId = `pg-access-ws-${suffix}`;
  const notebookId = `pg-access-nb-${suffix}`;
  const noteId = `pg-access-note-${suffix}`;
  const linkId = `pg-access-link-${suffix}`;
  const expiredLinkId = `pg-access-link-expired-${suffix}`;
  const userCommentId = `pg-access-comment-user-${suffix}`;
  const guestCommentId = `pg-access-comment-guest-${suffix}`;
  const activeSessionId = `pg-access-session-active-${suffix}`;
  const otherSessionId = `pg-access-session-other-${suffix}`;
  const expiredSessionId = `pg-access-session-expired-${suffix}`;
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  for (const userId of [ownerId, memberId]) {
    await pool.query(
      `INSERT INTO users (id, username, "passwordHash") VALUES ($1, $2, $3)`,
      [userId, userId, "hash"],
    );
  }
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, $2, $3)`,
    [workspaceId, "Access Workspace", ownerId],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name, "workspaceId") VALUES ($1, $2, $3, $4)`,
    [notebookId, ownerId, "Access Notebook", workspaceId],
  );
  await pool.query(
    `INSERT INTO notes (id, "userId", "notebookId", title, "workspaceId") VALUES ($1, $2, $3, $4, $5)`,
    [noteId, ownerId, notebookId, "Access Note", workspaceId],
  );

  try {
    const { notebookShareLinksRepository } = await import("../src/repositories/notebookShareLinksRepository");
    await notebookShareLinksRepository.createAsync({
      id: linkId,
      notebookId,
      token: `token-${suffix}`,
      role: "viewer",
      expiresAt: future,
      createdBy: ownerId,
    });
    await notebookShareLinksRepository.createAsync({
      id: expiredLinkId,
      notebookId,
      token: `expired-token-${suffix}`,
      role: "viewer",
      expiresAt: past,
      createdBy: ownerId,
    });

    const details = await notebookShareLinksRepository.getByTokenWithDetailsAsync(`token-${suffix}`);
    assert.equal(details?.enabled, 1);
    assert.equal(details?.notebookId, notebookId);
    assert.equal(typeof details?.createdAt, "string");
    assert.equal(await notebookShareLinksRepository.getEnabledByTokenAsync(`expired-token-${suffix}`), undefined);

    await notebookShareLinksRepository.updateAsync(linkId, { enabled: 0 });
    assert.equal(await notebookShareLinksRepository.getEnabledByTokenAsync(`token-${suffix}`), undefined);
    await notebookShareLinksRepository.updateAsync(linkId, { enabled: 1, role: "editor", expiresAt: future });
    const latest = await notebookShareLinksRepository.getLatestEnabledByNotebookAsync(notebookId);
    assert.equal(latest?.enabled, 1);
    assert.equal(latest?.role, "editor");
    assert.equal(typeof latest?.updatedAt, "string");

    const { shareCommentsRepository } = await import("../src/repositories/shareCommentsRepository");
    await shareCommentsRepository.createAsync({
      id: userCommentId,
      noteId,
      userId: ownerId,
      content: "owner comment",
    });
    await shareCommentsRepository.createAsync({
      id: guestCommentId,
      noteId,
      userId: null,
      guestName: "Guest",
      guestIpHash: "hash",
      content: "guest comment",
    });

    assert.equal(await shareCommentsRepository.countByUserAsync(ownerId), 1);
    assert.equal((await shareCommentsRepository.getResolvedAsync(userCommentId))?.isResolved, 0);
    await shareCommentsRepository.updateResolvedAsync(userCommentId, 1);
    assert.equal((await shareCommentsRepository.getResolvedAsync(userCommentId))?.isResolved, 1);

    const publicComments = await shareCommentsRepository.listByNoteIdWithUserForPublicAsync(noteId);
    const ownerComment = publicComments.find((comment) => comment.id === userCommentId);
    const guestComment = publicComments.find((comment) => comment.id === guestCommentId);
    assert.equal(ownerComment?.isGuest, 0);
    assert.equal(ownerComment?.isResolved, 1);
    assert.equal(guestComment?.isGuest, 1);
    assert.equal(typeof ownerComment?.createdAt, "string");
    assert.equal(await shareCommentsRepository.transferOwnershipAsync(ownerId, memberId), 1);
    assert.equal(await shareCommentsRepository.countByUserAsync(memberId), 1);

    const { userSessionsRepository } = await import("../src/repositories/userSessionsRepository");
    await userSessionsRepository.createAsync({
      id: activeSessionId,
      userId: ownerId,
      ip: "127.0.0.1",
      userAgent: "test-agent",
      deviceLabel: "primary",
      expiresAt: future,
    });
    await userSessionsRepository.createAsync({
      id: otherSessionId,
      userId: ownerId,
      ip: "127.0.0.2",
      userAgent: "test-agent",
      deviceLabel: "secondary",
      expiresAt: future,
    });
    await userSessionsRepository.createAsync({
      id: expiredSessionId,
      userId: ownerId,
      ip: "127.0.0.3",
      userAgent: "test-agent",
      deviceLabel: "expired",
      expiresAt: past,
    });

    assert.equal((await userSessionsRepository.findByDeviceAsync(ownerId, "primary"))?.id, activeSessionId);
    const activeBeforeRevoke = await userSessionsRepository.listActiveByUserAsync(ownerId);
    assert.deepEqual(
      activeBeforeRevoke.map((session) => session.id).sort(),
      [activeSessionId, otherSessionId].sort(),
    );
    assert.equal(typeof activeBeforeRevoke[0]?.createdAt, "string");
    assert.equal(await userSessionsRepository.revokeAllOtherAsync(ownerId, activeSessionId), 1);
    assert.equal((await userSessionsRepository.listActiveByUserAsync(ownerId)).length, 1);
    assert.equal(await userSessionsRepository.cleanupExpiredAsync(ownerId), 2);

    await userSessionsRepository.updateLastSeenAsync(activeSessionId, "127.0.0.9", future);
    await userSessionsRepository.revokeAsync(activeSessionId, "test");
    const revoked = await userSessionsRepository.getByIdAndUserAsync(activeSessionId, ownerId);
    assert.equal(typeof revoked?.revokedAt, "string");
    assert.equal(await userSessionsRepository.cleanupExpiredAsync(ownerId), 1);
  } finally {
    await pool.query(`DELETE FROM user_sessions WHERE "userId" = $1`, [ownerId]);
    await pool.query(`DELETE FROM share_comments WHERE "noteId" = $1`, [noteId]);
    await pool.query(`DELETE FROM notebook_share_links WHERE "notebookId" = $1`, [notebookId]);
    await pool.query(`DELETE FROM notes WHERE id = $1`, [noteId]);
    await pool.query(`DELETE FROM notebooks WHERE id = $1`, [notebookId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[ownerId, memberId]]);
    await runtime.resetDatabaseRuntimeForTests();
  }
});
