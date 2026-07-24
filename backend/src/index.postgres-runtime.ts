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
import createNotesRuntimeRouter from "./routes/notes-runtime";

const app = new Hono();
const port = Number(process.env.PORT) || 3001;
const adapter = getDatabaseAdapter();

app.use("*", logger());
app.use("*", cors({
  origin: (origin) => origin || "*",
  allowMethods: ["GET", "PUT", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Connection-Id"],
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
        "GET /api/notes/:id",
        "PUT /api/notes/:id (tiptap-json, markdown, html, core metadata)",
      ],
    },
  }, status);
});

async function authenticateNoteRequest(c: Context, next: Next) {
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
      `UPDATE user_sessions SET "lastSeenAt" = CURRENT_TIMESTAMP WHERE id = ?`,
      [payload.jti],
    ).catch((error) => {
      console.warn("[postgres-runtime] session lastSeen update failed:", error instanceof Error ? error.message : error);
    });
  }

  c.req.raw.headers.set("X-User-Id", payload.userId);
  if (payload.jti) c.req.raw.headers.set("X-Session-Id", payload.jti);
  await next();
}

// The notes collection (list/create) is not part of this migration slice.
// Register it explicitly so clients get a note-specific pending code instead of the global fallback.
app.all("/api/notes", (c) => c.json({
  error: "该笔记集合操作尚未迁移到 PostgreSQL Runtime",
  code: "POSTGRES_NOTE_ROUTE_MIGRATION_PENDING",
}, 503));

// Only the migrated single-note boundary is authenticated and enabled.
// Remaining note subroutes continue to return the note-specific runtime-pending response.
app.use("/api/notes/:id", authenticateNoteRequest);
app.use("/api/notes/:id/*", authenticateNoteRequest);
app.route("/api/notes", createNotesRuntimeRouter(adapter, "postgres"));

app.all("*", (c) => c.json({
  error: "PostgreSQL runtime is connected, but this route has not been migrated yet",
  code: "POSTGRES_RUNTIME_MIGRATION_PENDING",
  issue: 247,
}, 503));

console.log(`[db] PostgreSQL runtime-only mode enabled on port ${port}`);
console.warn("[db] Single-note read plus multi-format/core-metadata save is enabled; remaining business routes stay disabled until #249 completes");

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
