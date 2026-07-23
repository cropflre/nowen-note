import assert from "node:assert/strict";
import test from "node:test";

const databaseUrl = process.env.TEST_PG_DATABASE_URL;
const skip = !databaseUrl;

test("PG round-trip import batch metadata uses the Runtime Repository", { skip }, async () => {
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
  assert.ok(applied.some((item) => item.version === "0009_roundtrip_import_resource_links"));
  assert.ok(applied.some((item) => item.version === "0010_roundtrip_import_batches"));

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const userId = `pg-roundtrip-user-${suffix}`;
  const completedId = `pg-roundtrip-completed-${suffix}`;
  const failedId = `pg-roundtrip-failed-${suffix}`;
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();

  await pool.query(
    'INSERT INTO users (id, username, "passwordHash") VALUES ($1, $2, $3)',
    [userId, userId, "hash"],
  );

  try {
    const { roundTripImportBatchesRepository: repository } = await import(
      "../src/repositories/roundTripImportBatchesRepository"
    );

    await repository.create({
      id: completedId,
      userId,
      workspaceId: null,
      workspaceScope: "personal",
      importMode: "new-root",
      packageKind: "nowen",
      sourceInstanceId: "source-instance",
      sourceExportBatchId: "export-batch",
      previewJson: JSON.stringify({ counts: { notes: 1 } }),
      undoStateJson: JSON.stringify({ version: 1 }),
      undoAvailable: true,
      undoUnavailableReason: null,
      undoExpiresAt: past,
    });

    await repository.markCompleted({
      batchId: completedId,
      resultJson: JSON.stringify({ success: true, counts: { notes: 1 } }),
      undoStateJson: JSON.stringify({ version: 1, ready: true }),
      undoAvailable: true,
      undoUnavailableReason: null,
    });

    const completed = await repository.getByUserAndId(userId, completedId);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.undoAvailable, true);
    assert.equal(typeof completed?.createdAt, "string");
    assert.equal(typeof completed?.completedAt, "string");
    assert.deepEqual(JSON.parse(completed?.resultJson || "{}"), {
      success: true,
      counts: { notes: 1 },
    });

    const expired = await repository.findExpiredUndoIds(new Date().toISOString());
    assert.ok(expired.includes(completedId));
    await repository.markUndoExpired([completedId]);
    const expiredRow = await repository.getByUserAndId(userId, completedId);
    assert.equal(expiredRow?.undoAvailable, false);
    assert.equal(expiredRow?.undoUnavailableReason, "撤销窗口已过期");

    await repository.create({
      id: failedId,
      userId,
      workspaceId: null,
      workspaceScope: "personal",
      importMode: "sync",
      packageKind: "nowen",
      sourceInstanceId: null,
      sourceExportBatchId: null,
      previewJson: "{}",
      undoStateJson: "{}",
      undoAvailable: false,
      undoUnavailableReason: null,
      undoExpiresAt: future,
    });
    await repository.markFailed(
      failedId,
      JSON.stringify({ success: false }),
      "failed safely",
    );
    await repository.setUndoError(failedId, "diagnostic");

    const failed = await repository.getByUserAndId(userId, failedId);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.undoAvailable, false);
    assert.equal(failed?.undoUnavailableReason, "failed safely");
    assert.equal(failed?.undoError, "diagnostic");

    const personalRows = await repository.listByUser(userId, {
      workspaceScope: "personal",
      limit: 10,
    });
    assert.equal(personalRows.length, 2);
    assert.deepEqual(new Set(personalRows.map((row) => row.id)), new Set([completedId, failedId]));

    const allRows = await repository.listByUser(userId, { limit: 1 });
    assert.equal(allRows.length, 1);
  } finally {
    await pool.query('DELETE FROM roundtrip_import_batches WHERE "userId" = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await runtime.resetDatabaseRuntimeForTests();
  }
});
