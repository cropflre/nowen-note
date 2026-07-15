import { getDatabaseDriver, initializeDatabase } from "./db/runtime.js";

async function bootstrap(): Promise<void> {
  // Select and verify the database before importing modules with SQLite side effects.
  await initializeDatabase();

  if (getDatabaseDriver() === "postgres") {
    await import("./index.postgres-runtime.js");
    return;
  }

  // index.ts imports task-stats-hardening before registering routes, preserving the
  // existing SQLite startup order without evaluating it in PostgreSQL mode.
  await import("./index.js");
}

void bootstrap().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[startup] database runtime initialization failed:", message);
  process.exitCode = 1;
});
