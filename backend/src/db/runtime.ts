import { Pool, type PoolConfig } from "pg";
import type { DatabaseAdapter } from "./adapters/types";
import type { DatabaseDialect } from "./dialect";
import { PostgresAdapter } from "./postgresAdapter";

export type DatabaseDriver = "sqlite" | "postgres";

export interface DatabaseRuntimeConfig {
  driver: DatabaseDriver;
  sqlitePath?: string;
  databaseUrl?: string;
  postgres: {
    max: number;
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
  };
}

export interface DatabaseRuntimeDependencies {
  createPostgresPool?: (config: PoolConfig) => Pool;
  createSqliteAdapter?: () => DatabaseAdapter;
  closeSqlite?: () => void | Promise<void>;
  logger?: Pick<Console, "log" | "warn">;
}

export interface DatabaseHealth {
  ok: boolean;
  driver: DatabaseDriver;
  latencyMs: number;
  error?: string;
}

interface DatabaseRuntimeState {
  config: DatabaseRuntimeConfig;
  adapter: DatabaseAdapter;
  pool?: Pool;
  closeSqlite: () => void | Promise<void>;
}

const DEFAULT_PG_POOL_MAX = 10;
const DEFAULT_PG_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_PG_IDLE_TIMEOUT_MS = 30_000;

let runtimeState: DatabaseRuntimeState | undefined;
let initializationPromise: Promise<DatabaseRuntimeState> | undefined;
let initializationDriver: DatabaseDriver | undefined;

function parseIntegerSetting(
  rawValue: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (rawValue === undefined || rawValue.trim() === "") return defaultValue;

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`[db] ${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateDatabaseUrl(rawValue: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error("[db] DATABASE_URL must be a valid PostgreSQL connection URL");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("[db] DATABASE_URL must use the postgres:// or postgresql:// protocol");
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    throw new Error("[db] DATABASE_URL must include a host and database name");
  }
  return rawValue;
}

export function resolveDatabaseRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseRuntimeConfig {
  const rawDriver = (env.DB_DRIVER || "sqlite").trim().toLowerCase();
  if (rawDriver !== "sqlite" && rawDriver !== "postgres") {
    throw new Error("[db] DB_DRIVER must be either sqlite or postgres");
  }

  const config: DatabaseRuntimeConfig = {
    driver: rawDriver,
    sqlitePath: env.DB_PATH?.trim() || undefined,
    postgres: {
      max: parseIntegerSetting(env.PG_POOL_MAX, "PG_POOL_MAX", DEFAULT_PG_POOL_MAX, 1, 100),
      connectionTimeoutMillis: parseIntegerSetting(
        env.PG_CONNECTION_TIMEOUT_MS,
        "PG_CONNECTION_TIMEOUT_MS",
        DEFAULT_PG_CONNECTION_TIMEOUT_MS,
        100,
        120_000,
      ),
      idleTimeoutMillis: parseIntegerSetting(
        env.PG_IDLE_TIMEOUT_MS,
        "PG_IDLE_TIMEOUT_MS",
        DEFAULT_PG_IDLE_TIMEOUT_MS,
        1_000,
        600_000,
      ),
    },
  };

  if (config.driver === "postgres") {
    const databaseUrl = env.DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error("[db] DATABASE_URL is required when DB_DRIVER=postgres");
    }
    config.databaseUrl = validateDatabaseUrl(databaseUrl);
  }

  return config;
}

function buildPostgresPoolConfig(config: DatabaseRuntimeConfig): PoolConfig {
  return {
    connectionString: config.databaseUrl,
    max: config.postgres.max,
    connectionTimeoutMillis: config.postgres.connectionTimeoutMillis,
    idleTimeoutMillis: config.postgres.idleTimeoutMillis,
    application_name: "nowen-note",
  };
}

function describePostgresTarget(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    const port = parsed.port ? `:${parsed.port}` : "";
    const database = parsed.pathname.replace(/^\//, "") || "unknown";
    return `${parsed.hostname}${port}/${database}`;
  } catch {
    return "configured target";
  }
}

async function createSqliteRuntime(
  config: DatabaseRuntimeConfig,
  dependencies: DatabaseRuntimeDependencies,
): Promise<DatabaseRuntimeState> {
  if (dependencies.createSqliteAdapter) {
    return {
      config,
      adapter: dependencies.createSqliteAdapter(),
      closeSqlite: dependencies.closeSqlite ?? (() => undefined),
    };
  }

  // Keep PostgreSQL startup independent from the better-sqlite3 native module.
  // These modules are loaded only after DB_DRIVER has resolved to sqlite.
  const [{ SqliteAdapter }, { getDb, closeDb }] = await Promise.all([
    import("./adapters/index.js"),
    import("./schema.js"),
  ]);

  return {
    config,
    adapter: new SqliteAdapter(getDb()),
    closeSqlite: dependencies.closeSqlite ?? closeDb,
  };
}

async function initializeRuntime(
  config: DatabaseRuntimeConfig,
  dependencies: DatabaseRuntimeDependencies,
): Promise<DatabaseRuntimeState> {
  const logger = dependencies.logger ?? console;

  if (config.driver === "sqlite") {
    const state = await createSqliteRuntime(config, dependencies);
    logger.log(`[db] runtime initialized: sqlite${config.sqlitePath ? ` (${config.sqlitePath})` : ""}`);
    return state;
  }

  const poolConfig = buildPostgresPoolConfig(config);
  const pool = dependencies.createPostgresPool?.(poolConfig) ?? new Pool(poolConfig);

  try {
    await pool.query("SELECT 1 AS ok");
  } catch {
    try { await pool.end(); } catch { /* ignore cleanup errors */ }
    throw new Error("[db] PostgreSQL health check failed; verify DATABASE_URL and server availability");
  }

  const state: DatabaseRuntimeState = {
    config,
    adapter: new PostgresAdapter(pool),
    pool,
    closeSqlite: () => undefined,
  };
  logger.log(`[db] runtime initialized: postgres (${describePostgresTarget(config.databaseUrl!)})`);
  return state;
}

export async function initializeDatabase(options: {
  env?: NodeJS.ProcessEnv;
  dependencies?: DatabaseRuntimeDependencies;
} = {}): Promise<void> {
  const config = resolveDatabaseRuntimeConfig(options.env ?? process.env);

  if (runtimeState) {
    if (runtimeState.config.driver !== config.driver) {
      throw new Error("[db] database runtime is already initialized with a different driver");
    }
    return;
  }

  if (initializationPromise && initializationDriver !== config.driver) {
    throw new Error("[db] database runtime is already initializing with a different driver");
  }

  if (!initializationPromise) {
    initializationDriver = config.driver;
    initializationPromise = initializeRuntime(config, options.dependencies ?? {});
  }

  try {
    runtimeState = await initializationPromise;
  } finally {
    initializationPromise = undefined;
    initializationDriver = undefined;
  }
}

function requireRuntimeState(): DatabaseRuntimeState {
  if (!runtimeState) {
    throw new Error("[db] database runtime has not been initialized");
  }
  return runtimeState;
}

export function getDatabaseAdapter(): DatabaseAdapter {
  return requireRuntimeState().adapter;
}

export function getDatabaseDriver(): DatabaseDriver {
  return requireRuntimeState().config.driver;
}

export function getDatabaseDialect(): DatabaseDialect {
  return getDatabaseDriver();
}

export function isSqliteRuntime(): boolean {
  return getDatabaseDriver() === "sqlite";
}

export function isPostgresRuntime(): boolean {
  return getDatabaseDriver() === "postgres";
}

export function getDatabaseRuntimeStatus(): {
  initialized: boolean;
  driver?: DatabaseDriver;
  ready: boolean;
} {
  return {
    initialized: Boolean(runtimeState),
    driver: runtimeState?.config.driver,
    ready: Boolean(runtimeState),
  };
}

export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  const state = requireRuntimeState();
  const startedAt = Date.now();
  try {
    await state.adapter.queryOne<{ ok: number }>("SELECT 1 AS ok");
    return {
      ok: true,
      driver: state.config.driver,
      latencyMs: Date.now() - startedAt,
    };
  } catch {
    return {
      ok: false,
      driver: state.config.driver,
      latencyMs: Date.now() - startedAt,
      error: "database health check failed",
    };
  }
}

export async function closeDatabase(): Promise<void> {
  if (initializationPromise && !runtimeState) {
    try { runtimeState = await initializationPromise; } catch { /* initialization already failed */ }
  }
  initializationPromise = undefined;
  initializationDriver = undefined;

  const state = runtimeState;
  runtimeState = undefined;
  if (!state) return;

  if (state.pool) {
    await state.pool.end();
  } else {
    await state.closeSqlite();
  }
}

/** Test-only reset hook. Do not call from production code. */
export async function resetDatabaseRuntimeForTests(): Promise<void> {
  await closeDatabase();
}
