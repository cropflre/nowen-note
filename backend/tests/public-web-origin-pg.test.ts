import assert from "node:assert/strict";
import test from "node:test";

const databaseUrl = process.env.TEST_PG_DATABASE_URL;
const skip = !databaseUrl;

test("PG public web origin persistence uses the Runtime Repository", { skip }, async () => {
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

  const originKey = "site_public_web_origin";
  const sourceKey = "site_public_web_origin_source";

  try {
    await pool.query("DELETE FROM system_settings WHERE key = ANY($1::text[])", [[originKey, sourceKey]]);

    const origin = await import("../src/lib/public-web-origin");
    const { systemSettingsRepository } = await import("../src/repositories/systemSettingsRepository");

    const fromEnvironment = await origin.syncRuntimePublicWebOriginSetting({
      PUBLIC_WEB_ORIGIN: "https://env.example.com/public///",
    });
    assert.deepEqual(fromEnvironment, {
      origin: "https://env.example.com/public",
      source: "environment",
    });

    let rows = await systemSettingsRepository.getManyAsync([originKey, sourceKey]);
    let values = new Map(rows.map((row) => [row.key, row.value]));
    assert.equal(values.get(originKey), "https://env.example.com/public");
    assert.equal(values.get(sourceKey), "environment");

    await systemSettingsRepository.setManyAsync([
      { key: originKey, value: "https://admin.example.com" },
      { key: sourceKey, value: "settings" },
    ]);

    const fromSettings = await origin.syncRuntimePublicWebOriginSetting({
      PUBLIC_WEB_ORIGIN: "https://other-env.example.com",
    });
    assert.deepEqual(fromSettings, {
      origin: "https://admin.example.com",
      source: "settings",
    });

    await systemSettingsRepository.setManyAsync([
      { key: originKey, value: "https://stale-env.example.com" },
      { key: sourceKey, value: "environment" },
    ]);

    const afterEnvironmentRemoval = await origin.syncRuntimePublicWebOriginSetting({});
    assert.deepEqual(afterEnvironmentRemoval, { origin: "", source: "current" });

    rows = await systemSettingsRepository.getManyAsync([originKey, sourceKey]);
    values = new Map(rows.map((row) => [row.key, row.value]));
    assert.equal(values.get(originKey), "");
    assert.equal(values.get(sourceKey), "current");
  } finally {
    await pool.query("DELETE FROM system_settings WHERE key = ANY($1::text[])", [[originKey, sourceKey]]);
    await runtime.resetDatabaseRuntimeForTests();
  }
});
