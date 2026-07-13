// Install schema/route hardening before the main backend module evaluates.
import "./runtime/task-stats-hardening.js";
import { getDatabaseDriver, initializeDatabase } from "./db/runtime.js";

async function bootstrap(): Promise<void> {
  await initializeDatabase();

  if (getDatabaseDriver() === "postgres") {
    await import("./index.postgres-runtime.js");
    return;
  }

  await import("./index.js");
}

void bootstrap().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[startup] database runtime initialization failed:", message);
  process.exitCode = 1;
});
