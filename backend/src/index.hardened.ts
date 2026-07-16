import { getDatabaseDriver, initializeDatabase } from "./db/runtime.js";

async function bootstrap(): Promise<void> {
  // Select and verify the database before importing modules with SQLite side effects.
  await initializeDatabase();

  if (getDatabaseDriver() === "postgres") {
    const { runPostgresMigrations } = await import("./db/postgres/migrations.js");
    const applied = await runPostgresMigrations();
    console.log(`[db] PostgreSQL schema ready (${applied.length} versioned migrations)`);
    await import("./index.postgres-runtime.js");
    return;
  }

  // Preserve the current SQLite startup hardening order without evaluating it in PostgreSQL mode.
  await import("./runtime/task-stats-hardening.js");
  await import("./runtime/auto-full-backup.js");
  await import("./runtime/notebook-publication.js");
  await import("./index.js");
}

void bootstrap().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[startup] database runtime initialization failed:", message);
  process.exitCode = 1;
});
