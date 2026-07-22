import assert from "node:assert/strict";
import test from "node:test";

const databaseUrl = process.env.TEST_PG_DATABASE_URL;
const skip = !databaseUrl;

test("PG image hosting settings use the runtime repository", { skip }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  const runtime = await import("../src/db/runtime");
  const keys = ["imageHosting:config", "imageHosting:fallbackToLocal"];

  process.env.IMAGE_HOSTING_ENCRYPTION_KEY = "pg-image-hosting-test-key-2026";
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
  await pool.query('DELETE FROM system_settings WHERE key = ANY($1::text[])', [keys]);

  try {
    const hosting = await import("../src/services/image-hosting");
    const policy = await import("../src/services/image-hosting-policy");

    assert.equal(await policy.readImageHostingFallbackToLocal(), true);
    assert.equal(await policy.writeImageHostingFallbackToLocal(false), false);
    assert.equal(await policy.readImageHostingFallbackToLocal(), false);

    const first = await hosting.writeImageHostingConfig({
      enabled: true,
      endpoint: "https://s3.example.test/",
      region: "auto",
      bucket: "images",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      publicBaseUrl: "https://cdn.example.test/",
      pathPrefix: "/uploads/",
      usePathStyle: true,
      maxFileSizeMb: 12,
      allowedTypes: ["image/png"],
    });

    assert.equal(first.endpoint, "https://s3.example.test");
    assert.equal(first.publicBaseUrl, "https://cdn.example.test");
    assert.equal(first.pathPrefix, "uploads");
    assert.equal(first.secretAccessKeySet, true);
    assert.equal(await hosting.isImageHostingEnabled(), true);

    const raw = await pool.query(
      'SELECT value FROM system_settings WHERE key = $1',
      ["imageHosting:config"],
    );
    const stored = JSON.parse(raw.rows[0].value) as { secretAccessKeyEnc: string };
    assert.match(stored.secretAccessKeyEnc, /^v1:/);
    assert.doesNotMatch(raw.rows[0].value, /secret-key/);

    const updated = await hosting.writeImageHostingConfig({
      enabled: true,
      endpoint: "https://s3.example.test",
      bucket: "images-v2",
      accessKeyId: "access-key",
      publicBaseUrl: "https://cdn.example.test",
    });
    assert.equal(updated.bucket, "images-v2");
    assert.equal(updated.secretAccessKeySet, true);

    const deleted = await hosting.deleteImageHostingConfig();
    assert.equal(deleted.enabled, false);
    assert.equal(deleted.secretAccessKeySet, false);
    assert.equal(await hosting.isImageHostingEnabled(), false);

    await policy.deleteImageHostingFallbackPolicy();
    assert.equal(await policy.readImageHostingFallbackToLocal(), true);
  } finally {
    await pool.query('DELETE FROM system_settings WHERE key = ANY($1::text[])', [keys]);
    await runtime.resetDatabaseRuntimeForTests();
  }
});
