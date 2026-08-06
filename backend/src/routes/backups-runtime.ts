import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { Hono, type Context } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import {
  createPostgresBackupRuntime,
  PostgresBackupRuntimeError,
  type PostgresBackupRuntime,
} from "../services/postgres-backup-runtime";
import {
  createPostgresRestoreDrillRuntime,
  type PostgresRestoreDrillRuntime,
} from "../services/postgres-restore-drill-runtime";

function userIdOf(c: Context): string {
  return c.req.header("X-User-Id") || "";
}

function failure(c: Context, error: unknown): Response {
  if (error instanceof PostgresBackupRuntimeError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  console.error(
    "[postgres-backup-runtime] request failed:",
    error instanceof Error ? error.message : error,
  );
  return c.json({
    error: "PostgreSQL 备份请求失败",
    code: "POSTGRES_BACKUP_FAILED",
  }, 500);
}

export default function createBackupsRuntimeRouter(
  adapter: DatabaseAdapter,
  runtime?: PostgresBackupRuntime,
  restoreRuntime?: PostgresRestoreDrillRuntime,
) {
  const app = new Hono();
  const backups = runtime ?? createPostgresBackupRuntime({ adapter });
  const restoreDrill = restoreRuntime ?? createPostgresRestoreDrillRuntime({
    backupRuntime: backups,
  });

  app.get("/status", async (c) => {
    try {
      const health = await backups.health(userIdOf(c));
      return c.json({ ...health, restoreDrillReady: true });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get("/", async (c) => {
    try {
      return c.json(await backups.listBackups(userIdOf(c)));
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/", async (c) => {
    let body: { type?: "db-only" | "full"; description?: string } = {};
    try {
      body = await c.req.json<{ type?: "db-only" | "full"; description?: string }>();
    } catch {
      body = {};
    }
    if (body.type && body.type !== "db-only" && body.type !== "full") {
      return c.json({
        error: "type 仅支持 db-only 或 full",
        code: "POSTGRES_BACKUP_TYPE_INVALID",
      }, 400);
    }
    try {
      return c.json(await backups.createBackup(userIdOf(c), body), 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get("/:filename/download", async (c) => {
    try {
      const filePath = await backups.getBackupPath(userIdOf(c), c.req.param("filename"));
      const stat = fs.statSync(filePath);
      const content = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>;
      return new Response(content, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${path.basename(filePath)}"`,
          "Content-Length": String(stat.size),
        },
      });
    } catch (error) {
      return failure(c, error);
    }
  });

  /**
   * 在随机临时数据库中执行真实 pg_restore，并在返回前强制删除临时数据库。
   * 该端点只做恢复演练与校验，不切换 DATABASE_URL，也不触碰当前业务库。
   */
  app.post("/:filename/restore-drill", async (c) => {
    try {
      return c.json(await restoreDrill.run(userIdOf(c), c.req.param("filename")));
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/:filename/restore", async (c) => {
    const queryDryRun = c.req.query("dryRun");
    let body: { dryRun?: boolean } = {};
    try {
      body = await c.req.json<{ dryRun?: boolean }>();
    } catch {
      body = {};
    }
    const dryRun = queryDryRun === "1" || queryDryRun === "true" || body.dryRun === true;
    if (!dryRun) {
      try {
        await backups.assertAdmin(userIdOf(c));
      } catch (error) {
        return failure(c, error);
      }
      return c.json({
        error: "PostgreSQL 破坏性恢复尚未开放；请先使用 dryRun 和 restore-drill 完成预检与临时库演练",
        code: "POSTGRES_RESTORE_APPLY_PENDING",
        issue: 253,
      }, 503);
    }
    try {
      return c.json(await backups.dryRunRestore(userIdOf(c), c.req.param("filename")));
    } catch (error) {
      return failure(c, error);
    }
  });

  return app;
}
