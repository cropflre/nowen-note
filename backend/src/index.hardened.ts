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

  // Preserve main's SQLite startup hardening order without evaluating it in PostgreSQL mode.
  // Install the system-resolver fallback before url-import captures dns.resolve4/resolve6.
  await import("./runtime/url-import-dns-compat.js");
  // Register feature migrations before any runtime imports can initialize the database.
  await import("./runtime/knowledge-tree-migration-bootstrap.js");
  // Permission routes import ACL services that may initialize database guards, so they must load
  // only after the feature migration list has been registered.
  await import("./runtime/notebook-permission-management.js");
  // Install schema/route hardening before the main backend module evaluates.
  await import("./runtime/task-stats-hardening.js");
  // Replace the fragile batch Xiaomi import with an isolated, idempotent route before /api/micloud mounts.
  await import("./runtime/micloud-import-hardening.js");
  // Recover interrupted embedding jobs before the legacy worker starts polling.
  await import("./runtime/embedding-queue-hardening.js");
  // Must load after task-stats-hardening so this wrapper registers selected-section splitting before
  // the legacy all-section route when /api/notes is mounted.
  await import("./runtime/note-split-selection.js");
  // Loaded after the Markdown selection wrapper so Tiptap requests are registered first, then
  // non-Tiptap requests continue through the existing Markdown and legacy handlers.
  await import("./runtime/note-split-tiptap.js");
  // Wrap /api/blocks/resolve before the standard block router so old noteId + blockId links can follow
  // durable note-split records without rewriting the source notes that contain those links.
  await import("./runtime/block-link-redirect.js");
  // Add an atomic Tiptap block patch endpoint while preserving all existing single-block routes.
  await import("./runtime/block-patch.js");
  await import("./runtime/auto-full-backup.js");
  // Mount encrypted WebDAV backup configuration and upload routes before /api/backups is registered.
  await import("./runtime/backup-webdav.js");
  await import("./runtime/notebook-publication.js");
  // Mount the unified content tree and capability guard around the legacy note/notebook routers.
  await import("./runtime/knowledge-tree.js");
  await import("./index.js");
}

void bootstrap().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[startup] database runtime initialization failed:", message);
  process.exitCode = 1;
});
