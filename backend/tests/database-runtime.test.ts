import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { Pool, PoolConfig } from "pg";
import type { DatabaseAdapter } from "../src/db/adapters/types";
import {
  checkDatabaseHealth,
  closeDatabase,
  getDatabaseAdapter,
  getDatabaseDialect,
  getDatabaseDriver,
  initializeDatabase,
  resetDatabaseRuntimeForTests,
  resolveDatabaseRuntimeConfig,
} from "../src/db/runtime";

const silentLogger = {
  log() { /* no-op */ },
  warn() { /* no-op */ },
};

function createFakeAdapter(): DatabaseAdapter {
  return {
    async queryOne<T>(): Promise<T | undefined> {
      return { ok: 1 } as T;
    },
    async queryMany<T>(): Promise<T[]> {
      return [];
    },
    async execute() {
      return { changes: 0 };
    },
    async executeBatch() {
      return { changes: 0 };
    },
    async executeStatements() {
      return { changes: 0 };
    },
  };
}

afterEach(async () => {
  await resetDatabaseRuntimeForTests();
});

test("database runtime defaults to SQLite", () => {
  const config = resolveDatabaseRuntimeConfig({});
  assert.equal(config.driver, "sqlite");
  assert.equal(config.postgres.max, 10);
  assert.equal(config.postgres.connectionTimeoutMillis, 5_000);
  assert.equal(config.postgres.idleTimeoutMillis, 30_000);
});

test("SQLite startup ignores invalid PostgreSQL-only settings", () => {
  const config = resolveDatabaseRuntimeConfig({
    DB_DRIVER: "sqlite",
    DATABASE_URL: "not-a-postgres-url",
    PG_POOL_MAX: "invalid",
    PG_CONNECTION_TIMEOUT_MS: "-1",
    PG_IDLE_TIMEOUT_MS: "0",
  });

  assert.equal(config.driver, "sqlite");
  assert.equal(config.databaseUrl, undefined);
  assert.equal(config.postgres.max, 10);
  assert.equal(config.postgres.connectionTimeoutMillis, 5_000);
  assert.equal(config.postgres.idleTimeoutMillis, 30_000);
});

test("database runtime rejects unsupported DB_DRIVER", () => {
  assert.throws(
    () => resolveDatabaseRuntimeConfig({ DB_DRIVER: "mysql" }),
    /DB_DRIVER must be either sqlite or postgres/,
  );
});

test("PostgreSQL requires DATABASE_URL and does not use test-only URL", () => {
  assert.throws(
    () => resolveDatabaseRuntimeConfig({
      DB_DRIVER: "postgres",
      TEST_PG_DATABASE_URL: "postgres://test:test@localhost:5432/test",
    }),
    /DATABASE_URL is required/,
  );
});

test("PostgreSQL validates connection URL protocol and target", () => {
  assert.throws(
    () => resolveDatabaseRuntimeConfig({
      DB_DRIVER: "postgres",
      DATABASE_URL: "mysql://user:secret@localhost:3306/nowen",
    }),
    /postgres:\/\/ or postgresql:\/\//,
  );
  assert.throws(
    () => resolveDatabaseRuntimeConfig({
      DB_DRIVER: "postgres",
      DATABASE_URL: "postgres://user:secret@localhost",
    }),
    /host and database name/,
  );
});

test("PostgreSQL pool settings are validated", () => {
  const config = resolveDatabaseRuntimeConfig({
    DB_DRIVER: "postgres",
    DATABASE_URL: "postgres://user:secret@db.example.com:5432/nowen",
    PG_POOL_MAX: "24",
    PG_CONNECTION_TIMEOUT_MS: "7000",
    PG_IDLE_TIMEOUT_MS: "45000",
  });

  assert.equal(config.driver, "postgres");
  assert.equal(config.postgres.max, 24);
  assert.equal(config.postgres.connectionTimeoutMillis, 7_000);
  assert.equal(config.postgres.idleTimeoutMillis, 45_000);
  assert.throws(
    () => resolveDatabaseRuntimeConfig({
      DB_DRIVER: "postgres",
      DATABASE_URL: "postgres://user:secret@db.example.com:5432/nowen",
      PG_POOL_MAX: "0",
    }),
    /PG_POOL_MAX/,
  );
});

test("SQLite runtime uses injected adapter and closes it", async () => {
  const adapter = createFakeAdapter();
  let closed = false;

  await initializeDatabase({
    env: { DB_DRIVER: "sqlite" },
    dependencies: {
      createSqliteAdapter: () => adapter,
      closeSqlite: () => { closed = true; },
      logger: silentLogger,
    },
  });

  assert.equal(getDatabaseDriver(), "sqlite");
  assert.equal(getDatabaseDialect(), "sqlite");
  assert.equal(getDatabaseAdapter(), adapter);
  assert.equal((await checkDatabaseHealth()).ok, true);

  await closeDatabase();
  assert.equal(closed, true);
});

test("PostgreSQL runtime creates one pool, checks health and closes it", async () => {
  let receivedConfig: PoolConfig | undefined;
  let queryCount = 0;
  let endCount = 0;

  const fakePool = {
    async query() {
      queryCount += 1;
      return { rows: [{ ok: 1 }], rowCount: 1 };
    },
    async end() {
      endCount += 1;
    },
  } as unknown as Pool;

  await initializeDatabase({
    env: {
      DB_DRIVER: "postgres",
      DATABASE_URL: "postgres://user:secret@db.example.com:5432/nowen",
      PG_POOL_MAX: "12",
    },
    dependencies: {
      createPostgresPool: (config) => {
        receivedConfig = config;
        return fakePool;
      },
      logger: silentLogger,
    },
  });

  assert.equal(getDatabaseDriver(), "postgres");
  assert.equal(getDatabaseDialect(), "postgres");
  assert.equal(receivedConfig?.max, 12);
  assert.equal(receivedConfig?.application_name, "nowen-note");
  assert.equal(queryCount, 1, "initialization should perform one health query");

  const health = await checkDatabaseHealth();
  assert.equal(health.ok, true);
  assert.equal(health.driver, "postgres");
  assert.equal(queryCount, 2);

  await closeDatabase();
  assert.equal(endCount, 1);
});

test("failed PostgreSQL health check closes pool and redacts connection details", async () => {
  let ended = false;
  const fakePool = {
    async query() {
      throw new Error("password=super-secret postgres://user:super-secret@db.example.com/nowen");
    },
    async end() {
      ended = true;
    },
  } as unknown as Pool;

  await assert.rejects(
    () => initializeDatabase({
      env: {
        DB_DRIVER: "postgres",
        DATABASE_URL: "postgres://user:super-secret@db.example.com:5432/nowen",
      },
      dependencies: {
        createPostgresPool: () => fakePool,
        logger: silentLogger,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /PostgreSQL health check failed/);
      assert.equal(error.message.includes("super-secret"), false);
      return true;
    },
  );

  assert.equal(ended, true);
});
