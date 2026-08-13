import { serve } from "@hono/node-server";
import { Hono, type Context, type Next } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Server } from "http";

import {
  checkDatabaseHealth,
  closeDatabase,
  getDatabaseAdapter,
  getDatabaseRuntimeStatus,
} from "./db/runtime";
import { verifyLoginToken } from "./lib/auth-security";
import createAuthRuntimeRouter from "./routes/auth-runtime";
import createSettingsRuntimeRouter from "./routes/settings-runtime";
import createBackupsRuntimeRouter from "./routes/backups-runtime";
import createNotesRuntimeRouter from "./routes/notes-runtime";
import createNoteTransfersRuntimeRouter from "./routes/note-transfers-runtime";
import createKnowledgeTreeRuntimeRouter from "./routes/knowledge-tree-runtime";
import createKnowledgeTreeSurfacesRuntimeRouter from "./routes/knowledge-tree-surfaces-runtime";
import createSearchRuntimeRouter from "./routes/search-runtime";
import { createNoteDeletionEffectsRuntime } from "./services/note-deletion-effects-runtime";
import { createNoteTransferEffectsRuntime } from "./services/note-transfer-effects-runtime";
import { createNoteTransferMoveDeletionRuntime } from "./services/note-transfer-move-deletion-runtime";
import { createNoteTransferOrchestrationRuntime } from "./services/note-transfer-orchestration-runtime";
import { createPostgresRealtimeRuntime } from "./services/postgres-realtime-runtime";
import { createPostgresYjsCompactionRuntime } from "./services/postgres-yjs-compaction-runtime";
import { createPostgresYjsSubdocumentWebsocketRuntime } from "./services/postgres-yjs-subdocuments-websocket-runtime";

const app = new Hono();
const port = Number(process.env.PORT) || 3001;
const adapter = getDatabaseAdapter();
const hub = createPostgresRealtimeRuntime(adapter);
const subdocumentWs = createPostgresYjsSubdocumentWebsocketRuntime(adapter, {
  publishMutation: hub.publishMutation,
});
const yjsCompaction = createPostgresYjsCompactionRuntime(adapter);
yjsCompaction.start();
const deletionEffects = createNoteDeletionEffectsRuntime(adapter, {
  publishRealtime: hub.publish,
});
const transferEffects = createNoteTransferEffectsRuntime(adapter, {
  publishRealtime: async (event) => {
    hub.publishToUser(event.actorUserId, {
      type: event.kind === "note.transfer.target_committed"
        ? "note:transfer-target-committed"
        : "note:transfer-completed",
      eventId: event.eventId,
      operationId: event.operationId,
      mode: event.mode,
      sourceWorkspaceId: event.sourceWorkspaceId,
      targetWorkspaceId: event.targetWorkspaceId,
      targetNotebookId: event.targetNotebookId,
      sourceNoteIds: event.sourceNoteIds,
      targetNoteIds: event.targetNoteIds,
      actorUserId: event.actorUserId,
    });
  },
});
transferEffects.start();
const transferMoveDeletion = createNoteTransferMoveDeletionRuntime(adapter);
transferMoveDeletion.start();
const transferOrchestration = createNoteTransferOrchestrationRuntime(adapter, {
  effects: transferEffects,
  moveDeletion: transferMoveDeletion,
});
transferOrchestration.start();

app.use("*", logger());
app.use("*", cors({
  origin: (origin) => origin || "*",
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Connection-Id", "Idempotency-Key"],
  credentials: true,
}));
app.use("/api/*", compress());

app.get("/api/health", async (c) => {
  const database = await checkDatabaseHealth();
  const runtime = getDatabaseRuntimeStatus();
  const status: 200 | 503 = database.ok ? 200 : 503;

  return c.json({
    status: database.ok ? "ok" : "error",
    version: process.env.APP_VERSION || process.env.npm_package_version || "unknown",
    database,
    runtime: {
      ...runtime,
      mode: "postgres-runtime-only",
      businessRoutesReady: false,
      migratedRoutes: [
        "GET /api/auth/register/config",
        "PUT /api/auth/register/config",
        "POST /api/auth/register",
        "POST /api/auth/login",
        "POST /api/auth/2fa/verify",
        "POST /api/auth/refresh",
        "POST /api/auth/logout",
        "GET /api/auth/verify",
        "GET /api/auth/sessions",
        "DELETE /api/auth/sessions/:id",
        "DELETE /api/auth/sessions",
        "GET /api/settings (public site bootstrap)",
        "PUT /api/settings (authenticated; admin guard for system settings)",
        "GET /api/notes",
        "POST /api/notes",
        "GET /api/notes/trash/summary",
        "DELETE /api/notes/trash/empty",
        "GET /api/notes/:id",
        "PUT /api/notes/:id (tiptap-json, markdown, html, core metadata, trash/restore/move)",
        "PUT /api/notes/reorder/batch",
        "DELETE /api/notes/:id",
        "GET /api/search",
        "GET /api/search/health",
        "POST /api/search/rebuild",
        "GET /api/backups",
        "GET /api/backups/status",
        "POST /api/backups (PostgreSQL db-only/full)",
        "GET /api/backups/:filename/download",
        "POST /api/backups/:filename/restore?dryRun=1",
        "POST /api/note-transfers (unified asynchronous copy/move orchestration)",
        "POST /api/note-transfers/preview",
        "POST /api/note-transfers/prepare",
        "POST /api/note-transfers/operations/:idempotencyKey/staging",
        "POST /api/note-transfers/operations/:idempotencyKey/staging/resume",
        "POST /api/note-transfers/operations/:idempotencyKey/commit",
        "POST /api/note-transfers/operations/:idempotencyKey/cancel",
        "POST /api/note-transfers/operations/:idempotencyKey/resume",
        "POST /api/note-transfers/operations/:idempotencyKey/cleanup/resume",
        "POST /api/note-transfers/operations/:idempotencyKey/effects/resume",
        "POST /api/note-transfers/operations/:idempotencyKey/source-deletion/resume",
        "GET /api/note-transfers/operations/:idempotencyKey (aggregated progress)",
        "GET /api/knowledge-tree",
        "GET /api/knowledge-tree/shared-with-me",
        "POST /api/knowledge-tree/nodes (folder, note, markdown and word)",
        "PUT /api/knowledge-tree/nodes/:nodeId/move",
        "PUT /api/knowledge-tree/reorder",
        "DELETE /api/knowledge-tree/nodes/:nodeId (subtree or promote children)",
        "POST /api/knowledge-tree/nodes/:nodeId/restore",
        "GET /api/knowledge-tree/nodes/:nodeId/permissions",
        "PUT /api/knowledge-tree/nodes/:nodeId/permissions",
        "DELETE /api/knowledge-tree/nodes/:nodeId/permissions/:userId",
        "GET /api/knowledge-tree/nodes/:nodeId/history",
        "POST /api/knowledge-tree/nodes/:nodeId/unlock",
        "PUT /api/knowledge-tree/nodes/:nodeId/password",
        "PATCH /api/knowledge-tree/nodes/:nodeId (title and expansion metadata)",
        "WS /ws (subscriptions, presence, note/workspace events and Yjs read/write sync)",
        "WS /ws/subdocuments (Tiptap manifest/state, stable-section and structure-changing Yjs writes)",
      ],
      migratedCapabilities: [
        "note deletion audit logs",
        "note deletion webhooks",
        "PostgreSQL weighted full-text search for note titles and content",
        "tag and attachment search with Unicode-safe literal fallback",
        "search health diagnostics and administrator index rebuild",
        "PostgreSQL custom-format pg_dump database backups",
        "database-independent backup manifests with table counts and checksums",
        "PostgreSQL full backups with attachments, fonts, plugins and JWT secret",
        "non-destructive pg_restore archive validation and restore dry-run",
        "note-transfer cross-driver preview and permission analysis",
        "note-transfer durable idempotency, source-version snapshots and transactional preparation",
        "note-transfer prepared-to-staging CAS and recoverable attachment manifests",
        "note-transfer local/S3 physical staging copy with leases, SHA-256 verification and crash recovery",
        "note-transfer atomic copy commit for notes, tags, links, attachments, references and block indexes",
        "note-transfer cancellable staging and recoverable local/S3 staged-object cleanup leases",
        "note-transfer transactional effects outbox with audit/webhook/realtime leases and stable event keys",
        "note-transfer move target-commit, effects gate and recoverable source database/file deletion",
        "note-transfer unified asynchronous orchestration, aggregated progress, retry and restart recovery",
        "knowledge-tree scope listing with inherited permissions",
        "knowledge-tree shared-root discovery with overlapping-root de-duplication",
        "knowledge-tree access-controlled history listing",
        "knowledge-tree transactional folder password versioning and unlock tokens",
        "knowledge-tree transactional folder and document creation",
        "knowledge-tree transactional move and batch reorder with stale-write rollback",
        "knowledge-tree transactional subtree deletion, child promotion and parent-first restore",
        "knowledge-tree idempotent restore and lifecycle history",
        "knowledge-tree transactional permission set/clear with direct and inherited access",
        "knowledge-tree permission idempotency, self-lockout prevention and stale-write rollback",
        "knowledge-tree title and expansion metadata mutations",
        "note and workspace room subscriptions",
        "note presence, editing and cursor events",
        "connection recovery through idempotent resubscription",
        "note create/update/trash/restore/move/reorder realtime events",
        "single and batch permanent deletion realtime events",
        "Yjs snapshot and update replay from PostgreSQL",
        "Yjs join, leave and state-vector read synchronization",
        "Yjs awareness relay between joined connections",
        "Yjs update persistence and notes.content dual-write",
        "Yjs snapshot compaction and update garbage collection",
        "Yjs subdocument manifest/state and stable-section write protocol",
        "Yjs subdocument idempotent structure changes and root manifest rebuild",
      ],
      realtime: hub.getStats(),
      noteTransferOrchestration: await transferOrchestration.getStats(),
      noteTransferEffects: await transferEffects.getStats(),
      noteTransferMoveDeletion: await transferMoveDeletion.getStats(),
      subdocuments: subdocumentWs.getStats(),
      yjsCompaction: yjsCompaction.getStats(),
      pendingCapabilities: [
        "PostgreSQL destructive restore through temporary database cutover (#253)",
        "PostgreSQL automatic backup scheduling and remote backup parity (#253)",
      ],
    },
  }, status);
});

async function authenticateApiRequest(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "未授权，请先登录", code: "UNAUTHENTICATED" }, 401);
  }

  const payload = verifyLoginToken(authHeader.slice(7));
  if (!payload?.userId) {
    return c.json({ error: "Token 无效或已过期", code: "TOKEN_INVALID" }, 401);
  }

  const user = await adapter.queryOne<{
    tokenVersion: number;
    isDisabled: boolean | number;
  }>(
    `SELECT "tokenVersion" AS "tokenVersion", "isDisabled" AS "isDisabled"
       FROM users WHERE id = ?`,
    [payload.userId],
  );
  if (!user) {
    return c.json({ error: "账号不存在或已被删除", code: "USER_NOT_FOUND" }, 401);
  }
  if (user.isDisabled === true || user.isDisabled === 1) {
    return c.json({ error: "该账号已被禁用，请联系管理员", code: "ACCOUNT_DISABLED" }, 403);
  }
  if ((payload.tver ?? 0) !== (user.tokenVersion ?? 0)) {
    return c.json({ error: "会话已失效，请重新登录", code: "TOKEN_REVOKED" }, 401);
  }

  if (payload.jti) {
    const session = await adapter.queryOne<{
      id: string;
      revokedAt: string | Date | null;
      expiresAt: string | Date | null;
    }>(
      `SELECT id, "revokedAt" AS "revokedAt", "expiresAt" AS "expiresAt"
         FROM user_sessions WHERE id = ? AND "userId" = ?`,
      [payload.jti, payload.userId],
    );
    if (!session) {
      return c.json({ error: "会话已失效，请重新登录", code: "TOKEN_REVOKED" }, 401);
    }
    if (session.revokedAt) {
      return c.json({ error: "该会话已被下线", code: "SESSION_REVOKED" }, 401);
    }
    if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) {
      return c.json({ error: "会话已过期，请重新登录", code: "SESSION_EXPIRED" }, 401);
    }
    void adapter.execute(
      `UPDATE user_sessions
          SET "lastSeenAt" = CURRENT_TIMESTAMP
        WHERE id = ? AND "userId" = ?`,
      [payload.jti, payload.userId],
    ).catch((error) => {
      console.warn("[postgres-runtime] session lastSeen update failed:", error instanceof Error ? error.message : String(error));
    });
  }

  c.req.raw.headers.set("X-User-Id", payload.userId);
  if (payload.jti) c.req.raw.headers.set("X-Session-Id", payload.jti);
  await next();
}

app.route("/api/auth", createAuthRuntimeRouter(adapter));

app.route("/api/settings", createSettingsRuntimeRouter(adapter));

app.use("/api/notes", authenticateApiRequest);
app.use("/api/notes/*", authenticateApiRequest);
app.route("/api/notes", createNotesRuntimeRouter(
  adapter,
  "postgres",
  { dispatchEffects: deletionEffects.dispatch },
  { publishMutation: hub.publishMutation },
));

app.use("/api/search", authenticateApiRequest);
app.use("/api/search/*", authenticateApiRequest);
app.route("/api/search", createSearchRuntimeRouter(adapter));

app.use("/api/backups", authenticateApiRequest);
app.use("/api/backups/*", authenticateApiRequest);
app.route("/api/backups", createBackupsRuntimeRouter(adapter));

app.use("/api/note-transfers", authenticateApiRequest);
app.use("/api/note-transfers/*", authenticateApiRequest);
app.route("/api/note-transfers", createNoteTransfersRuntimeRouter(adapter, {
  effects: transferEffects,
  moveDeletion: transferMoveDeletion,
  orchestration: transferOrchestration,
}));

app.use("/api/knowledge-tree", authenticateApiRequest);
app.use("/api/knowledge-tree/*", authenticateApiRequest);
app.route(
  "/api/knowledge-tree",
  createKnowledgeTreeRuntimeRouter(adapter, "postgres"),
);
app.route(
  "/api/knowledge-tree",
  createKnowledgeTreeSurfacesRuntimeRouter(adapter, "postgres"),
);

app.all("*", (c) => c.json({
  error: "PostgreSQL runtime is connected, but this route has not been migrated yet",
  code: "POSTGRES_RUNTIME_MIGRATION_PENDING",
  issue: 247,
}, 503));

console.log(`[db] PostgreSQL runtime-only mode enabled on port ${port}`);
console.warn("[db] Notes, full-text search, PostgreSQL backups, unified durable note-transfer copy/move orchestration and knowledge-tree routes are PostgreSQL-safe; production cutover remains disabled until remaining PostgreSQL phases complete");

const server = serve({ fetch: app.fetch, port }) as unknown as Server;
hub.attach(server);
subdocumentWs.attach(server);
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
    await transferOrchestration.shutdown();
    await transferMoveDeletion.shutdown();
    await transferEffects.shutdown();
    await yjsCompaction.close();
    await subdocumentWs.close();
    await hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await deletionEffects.shutdown();
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
