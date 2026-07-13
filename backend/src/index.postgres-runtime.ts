import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Server } from "http";
import {
  checkDatabaseHealth,
  closeDatabase,
  getDatabaseRuntimeStatus,
} from "./db/runtime";

const app = new Hono();
const port = Number(process.env.PORT) || 3001;

app.get("/api/health", async (c) => {
  const database = await checkDatabaseHealth();
  const runtime = getDatabaseRuntimeStatus();
  const status = database.ok ? 200 : 503;

  return c.json({
    status: database.ok ? "ok" : "error",
    version: process.env.APP_VERSION || process.env.npm_package_version || "unknown",
    database,
    runtime: {
      ...runtime,
      mode: "postgres-runtime-only",
      businessRoutesReady: false,
    },
  }, status);
});

app.all("*", (c) => c.json({
  error: "PostgreSQL runtime is connected, but this route has not been migrated yet",
  code: "POSTGRES_RUNTIME_MIGRATION_PENDING",
  issue: 247,
}, 503));

console.log(`[db] PostgreSQL runtime-only mode enabled on port ${port}`);
console.warn("[db] Business routes remain disabled until #248/#249 migrate direct SQLite access and repositories");

const server = serve({ fetch: app.fetch, port }) as unknown as Server;
let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] received ${signal}, closing PostgreSQL runtime...`);

  const forceExit = setTimeout(() => {
    console.warn("[shutdown] timeout (5s), force exit");
    process.exit(1);
  }, 5_000);
  forceExit.unref();

  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabase();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    console.warn("[shutdown] PostgreSQL runtime close failed:", error instanceof Error ? error.message : String(error));
    clearTimeout(forceExit);
    process.exit(1);
  }
}

process.once("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.once("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
