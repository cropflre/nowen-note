import assert from "node:assert/strict";
import test from "node:test";

const databaseUrl = process.env.TEST_PG_DATABASE_URL;
const skip = !databaseUrl;

test("PG Nowen instance identity is stable and race-safe", { skip }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  const runtime = await import("../src/db/runtime");
  const previousInstanceId = process.env.NOWEN_INSTANCE_ID;

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

  try {
    delete process.env.NOWEN_INSTANCE_ID;
    await pool.query("DELETE FROM system_settings WHERE key = 'nowen_instance_id'");

    const identity = await import("../src/services/nowenInstanceIdentity");
    const [first, second] = await Promise.all([
      identity.getNowenInstanceIdAsync(),
      identity.getNowenInstanceIdAsync(),
    ]);

    assert.match(first, /^[A-Za-z0-9._:-]{8,160}$/);
    assert.equal(second, first);

    const persisted = await pool.query(
      "SELECT value FROM system_settings WHERE key = 'nowen_instance_id'",
    );
    assert.equal(persisted.rowCount, 1);
    assert.equal(persisted.rows[0]?.value, first);

    const exportedId = await identity.ensureNowenInstanceEnvironmentAsync();
    assert.equal(exportedId, first);
    assert.equal(process.env.NOWEN_INSTANCE_ID, first);
  } finally {
    await pool.query("DELETE FROM system_settings WHERE key = 'nowen_instance_id'");
    if (previousInstanceId === undefined) delete process.env.NOWEN_INSTANCE_ID;
    else process.env.NOWEN_INSTANCE_ID = previousInstanceId;
    await runtime.resetDatabaseRuntimeForTests();
  }
});
