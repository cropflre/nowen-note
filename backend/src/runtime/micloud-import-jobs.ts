import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { getDb } from "../db/schema.js";
import {
  importMiCloudRow,
  prepareMiCloudImportTarget,
  type MiCloudImportScope,
} from "./micloud-import-hardening.js";

const ROUTE_PATCH_FLAG = Symbol.for("nowen.micloudImportJobs.routePatch");
const ROUTER_INSTALLED_FLAG = Symbol.for("nowen.micloudImportJobs.routerInstalled");
const MAX_JOB_NOTE_IDS = 5_000;
const JOB_CONCURRENCY = 3;
const SSE_HEARTBEAT_MS = 15_000;

export type MiCloudImportJobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

type JobRow = {
  id: string;
  userId: string;
  notebookId: string;
  status: MiCloudImportJobStatus;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  cancelRequested: number;
  currentExternalId: string | null;
  error: string | null;
  retryOfJobId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

type JobItemRow = {
  id: string;
  jobId: string;
  sequence: number;
  externalId: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  noteId: string | null;
  title: string | null;
  error: string | null;
  warning: string | null;
};

export type MiCloudImportJobSnapshot = {
  id: string;
  notebookId: string;
  status: MiCloudImportJobStatus;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  currentExternalId: string | null;
  error: string | null;
  retryOfJobId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  errors: string[];
};

type RuntimeState = {
  cookies: Map<string, string>;
  runningJobs: Set<string>;
  emitter: EventEmitter;
  schemaReady: boolean;
  recovered: boolean;
};

const runtimeGlobals = globalThis as typeof globalThis & {
  __nowenMiCloudImportJobs?: RuntimeState;
};
const runtime = runtimeGlobals.__nowenMiCloudImportJobs ||= {
  cookies: new Map<string, string>(),
  runningJobs: new Set<string>(),
  emitter: new EventEmitter(),
  schemaReady: false,
  recovered: false,
};
runtime.emitter.setMaxListeners(500);

function safeText(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return fallback;
  return text.replace(/\s+/g, " ").slice(0, 1_000);
}

function normalizeJobNoteIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_JOB_NOTE_IDS);
}

function isTerminal(status: MiCloudImportJobStatus): boolean {
  return status === "completed"
    || status === "partial"
    || status === "failed"
    || status === "cancelled";
}

function ensureJobSchema(): void {
  if (runtime.schemaReady) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS micloud_import_jobs (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      notebookId TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      total INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      succeeded INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      cancelRequested INTEGER NOT NULL DEFAULT 0,
      currentExternalId TEXT,
      error TEXT,
      retryOfJobId TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      startedAt TEXT,
      finishedAt TEXT,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (notebookId) REFERENCES notebooks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS micloud_import_job_items (
      id TEXT PRIMARY KEY,
      jobId TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      externalId TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      noteId TEXT,
      title TEXT,
      error TEXT,
      warning TEXT,
      startedAt TEXT,
      finishedAt TEXT,
      FOREIGN KEY (jobId) REFERENCES micloud_import_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE SET NULL,
      UNIQUE(jobId, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_micloud_import_jobs_user_status
      ON micloud_import_jobs(userId, status, createdAt);
    CREATE INDEX IF NOT EXISTS idx_micloud_import_job_items_job_status
      ON micloud_import_job_items(jobId, status, sequence);
  `);
  runtime.schemaReady = true;
}

function recoverInterruptedJobs(): void {
  if (runtime.recovered) return;
  ensureJobSchema();
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      UPDATE micloud_import_job_items
      SET status = 'failed',
          error = COALESCE(error, '服务重启，任务已中断'),
          finishedAt = datetime('now')
      WHERE status = 'running'
        AND jobId IN (
          SELECT id FROM micloud_import_jobs
          WHERE status IN ('queued', 'running', 'cancelling')
        )
    `).run();
    db.prepare(`
      UPDATE micloud_import_jobs
      SET status = 'failed',
          error = COALESCE(error, '服务重启后无法恢复小米 Cookie，请重新发起导入'),
          finishedAt = datetime('now'),
          updatedAt = datetime('now'),
          currentExternalId = NULL
      WHERE status IN ('queued', 'running', 'cancelling')
    `).run();
  })();
  runtime.recovered = true;
}

function notifyJob(jobId: string): void {
  runtime.emitter.emit(`job:${jobId}`);
}

function waitForJobSignal(jobId: string): Promise<"change" | "heartbeat"> {
  return new Promise((resolve) => {
    const eventName = `job:${jobId}`;
    let timer: ReturnType<typeof setTimeout>;
    const onChange = () => {
      clearTimeout(timer);
      resolve("change");
    };
    runtime.emitter.once(eventName, onChange);
    timer = setTimeout(() => {
      runtime.emitter.off(eventName, onChange);
      resolve("heartbeat");
    }, SSE_HEARTBEAT_MS);
  });
}

function getJobRow(jobId: string): JobRow | undefined {
  ensureJobSchema();
  return getDb().prepare(`
    SELECT
      id, userId, notebookId, status, total, processed, succeeded, failed,
      cancelRequested, currentExternalId, error, retryOfJobId,
      createdAt, startedAt, finishedAt, updatedAt
    FROM micloud_import_jobs
    WHERE id = ?
  `).get(jobId) as JobRow | undefined;
}

function getOwnedJobRow(jobId: string, userId: string): JobRow | undefined {
  const row = getJobRow(jobId);
  return row?.userId === userId ? row : undefined;
}

function toSnapshot(row: JobRow): MiCloudImportJobSnapshot {
  const failures = getDb().prepare(`
    SELECT sequence, externalId, error
    FROM micloud_import_job_items
    WHERE jobId = ? AND status = 'failed'
    ORDER BY sequence
    LIMIT 100
  `).all(row.id) as Array<{ sequence: number; externalId: string; error: string | null }>;

  return {
    id: row.id,
    notebookId: row.notebookId,
    status: row.status,
    total: row.total,
    processed: row.processed,
    succeeded: row.succeeded,
    failed: row.failed,
    currentExternalId: row.currentExternalId,
    error: row.error,
    retryOfJobId: row.retryOfJobId,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    updatedAt: row.updatedAt,
    errors: failures.map((item) =>
      `第 ${item.sequence + 1} 条（${item.externalId}）：${item.error || "导入失败"}`,
    ),
  };
}

function findActiveJob(userId: string): JobRow | undefined {
  ensureJobSchema();
  return getDb().prepare(`
    SELECT
      id, userId, notebookId, status, total, processed, succeeded, failed,
      cancelRequested, currentExternalId, error, retryOfJobId,
      createdAt, startedAt, finishedAt, updatedAt
    FROM micloud_import_jobs
    WHERE userId = ?
      AND status IN ('queued', 'running', 'cancelling')
    ORDER BY createdAt DESC
    LIMIT 1
  `).get(userId) as JobRow | undefined;
}

function queueJob(jobId: string): void {
  setImmediate(() => {
    void processJob(jobId).catch((error) => {
      console.error("[micloud/import-jobs] unhandled worker error", {
        jobId,
        error: error instanceof Error ? error.message : error,
      });
    });
  });
}

function createJobRecord(input: {
  userId: string;
  cookie: string;
  noteIds: string[];
  notebookId?: string;
  retryOfJobId?: string;
}): MiCloudImportJobSnapshot {
  ensureJobSchema();
  const scope = prepareMiCloudImportTarget(input.userId, input.notebookId);
  if (!scope) {
    const error = new Error("目标笔记本不存在、已删除或无写入权限");
    (error as Error & { code?: string }).code = "NOTEBOOK_FORBIDDEN";
    throw error;
  }

  const db = getDb();
  const jobId = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO micloud_import_jobs (
        id, userId, notebookId, status, total, retryOfJobId
      ) VALUES (?, ?, ?, 'queued', ?, ?)
    `).run(jobId, input.userId, scope.notebookId, input.noteIds.length, input.retryOfJobId || null);

    const insertItem = db.prepare(`
      INSERT INTO micloud_import_job_items (
        id, jobId, sequence, externalId, status
      ) VALUES (?, ?, ?, ?, 'pending')
    `);
    input.noteIds.forEach((externalId, sequence) => {
      insertItem.run(crypto.randomUUID(), jobId, sequence, externalId);
    });
  })();

  runtime.cookies.set(jobId, input.cookie);
  queueJob(jobId);
  const row = getJobRow(jobId);
  if (!row) throw new Error("导入任务创建后无法读取");
  notifyJob(jobId);
  return toSnapshot(row);
}

function markItemResult(input: {
  jobId: string;
  item: JobItemRow;
  success: boolean;
  noteId?: string;
  title?: string;
  error?: string;
  warning?: string;
}): void {
  const db = getDb();
  db.transaction(() => {
    if (input.success) {
      db.prepare(`
        UPDATE micloud_import_job_items
        SET status = 'succeeded', noteId = ?, title = ?, warning = ?, finishedAt = datetime('now')
        WHERE id = ?
      `).run(input.noteId || null, input.title || null, input.warning || null, input.item.id);
      db.prepare(`
        UPDATE micloud_import_jobs
        SET processed = processed + 1,
            succeeded = succeeded + 1,
            currentExternalId = NULL,
            updatedAt = datetime('now')
        WHERE id = ?
      `).run(input.jobId);
    } else {
      db.prepare(`
        UPDATE micloud_import_job_items
        SET status = 'failed', error = ?, finishedAt = datetime('now')
        WHERE id = ?
      `).run(input.error || "导入失败", input.item.id);
      db.prepare(`
        UPDATE micloud_import_jobs
        SET processed = processed + 1,
            failed = failed + 1,
            currentExternalId = NULL,
            updatedAt = datetime('now')
        WHERE id = ?
      `).run(input.jobId);
    }
  })();
  notifyJob(input.jobId);
}

async function processJob(jobId: string): Promise<void> {
  if (runtime.runningJobs.has(jobId)) return;
  runtime.runningJobs.add(jobId);

  try {
    const initial = getJobRow(jobId);
    if (!initial || isTerminal(initial.status)) return;

    const cookie = runtime.cookies.get(jobId);
    if (!cookie) {
      getDb().prepare(`
        UPDATE micloud_import_jobs
        SET status = 'failed',
            error = '小米 Cookie 已不在内存中，请重新发起导入',
            finishedAt = datetime('now'),
            updatedAt = datetime('now')
        WHERE id = ?
      `).run(jobId);
      notifyJob(jobId);
      return;
    }

    const scope = prepareMiCloudImportTarget(initial.userId, initial.notebookId);
    if (!scope) throw new Error("目标笔记本不存在、已删除或无写入权限");

    getDb().prepare(`
      UPDATE micloud_import_jobs
      SET status = CASE WHEN cancelRequested = 1 THEN 'cancelling' ELSE 'running' END,
          startedAt = COALESCE(startedAt, datetime('now')),
          updatedAt = datetime('now')
      WHERE id = ?
    `).run(jobId);
    notifyJob(jobId);

    const items = getDb().prepare(`
      SELECT id, jobId, sequence, externalId, status, noteId, title, error, warning
      FROM micloud_import_job_items
      WHERE jobId = ? AND status = 'pending'
      ORDER BY sequence
    `).all(jobId) as JobItemRow[];

    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        const job = getJobRow(jobId);
        if (!job || job.cancelRequested === 1) return;
        const item = items[nextIndex++];
        if (!item) return;

        getDb().transaction(() => {
          getDb().prepare(`
            UPDATE micloud_import_job_items
            SET status = 'running', startedAt = datetime('now')
            WHERE id = ? AND status = 'pending'
          `).run(item.id);
          getDb().prepare(`
            UPDATE micloud_import_jobs
            SET currentExternalId = ?, updatedAt = datetime('now')
            WHERE id = ?
          `).run(item.externalId, jobId);
        })();
        notifyJob(jobId);

        try {
          const result = await importMiCloudRow({
            cookie,
            externalId: item.externalId,
            userId: initial.userId,
            scope: scope as MiCloudImportScope,
          });
          if (result.success && result.note) {
            markItemResult({
              jobId,
              item,
              success: true,
              noteId: result.note.id,
              title: result.note.title,
              warning: result.errors.length > 0 ? result.errors.join("\n") : undefined,
            });
          } else {
            markItemResult({
              jobId,
              item,
              success: false,
              error: result.error || result.errors[0] || "导入失败",
            });
          }
        } catch (error) {
          markItemResult({
            jobId,
            item,
            success: false,
            error: safeText(error instanceof Error ? error.message : error, "导入失败"),
          });
        }
      }
    };

    await Promise.all(Array.from(
      { length: Math.min(JOB_CONCURRENCY, Math.max(items.length, 1)) },
      () => worker(),
    ));

    const final = getJobRow(jobId);
    if (!final) return;
    if (final.cancelRequested === 1) {
      getDb().transaction(() => {
        getDb().prepare(`
          UPDATE micloud_import_job_items
          SET status = 'cancelled', finishedAt = datetime('now')
          WHERE jobId = ? AND status = 'pending'
        `).run(jobId);
        getDb().prepare(`
          UPDATE micloud_import_jobs
          SET status = 'cancelled', currentExternalId = NULL,
              finishedAt = datetime('now'), updatedAt = datetime('now')
          WHERE id = ?
        `).run(jobId);
      })();
    } else {
      const status: MiCloudImportJobStatus = final.failed === 0
        ? "completed"
        : final.succeeded > 0
          ? "partial"
          : "failed";
      const firstFailure = final.failed > 0
        ? getDb().prepare(`
            SELECT error FROM micloud_import_job_items
            WHERE jobId = ? AND status = 'failed'
            ORDER BY sequence LIMIT 1
          `).get(jobId) as { error: string | null } | undefined
        : undefined;
      getDb().prepare(`
        UPDATE micloud_import_jobs
        SET status = ?, currentExternalId = NULL, error = ?,
            finishedAt = datetime('now'), updatedAt = datetime('now')
        WHERE id = ?
      `).run(
        status,
        status === "failed" ? firstFailure?.error || "没有成功导入任何小米笔记" : null,
        jobId,
      );
    }
    notifyJob(jobId);
  } catch (error) {
    const detail = safeText(error instanceof Error ? error.message : error, "后台导入任务失败");
    getDb().prepare(`
      UPDATE micloud_import_jobs
      SET status = 'failed', error = ?, currentExternalId = NULL,
          finishedAt = datetime('now'), updatedAt = datetime('now')
      WHERE id = ?
    `).run(detail, jobId);
    notifyJob(jobId);
  } finally {
    runtime.cookies.delete(jobId);
    runtime.runningJobs.delete(jobId);
  }
}

function requireUserId(c: Context): string | null {
  return c.req.header("X-User-Id") || null;
}

async function createImportJob(c: Context) {
  const userId = requireUserId(c);
  if (!userId) return c.json({ error: "未授权", code: "UNAUTHENTICATED" }, 401);
  const body = await c.req.json().catch(() => null) as
    | { cookie?: unknown; noteIds?: unknown; notebookId?: unknown }
    | null;
  const cookie = typeof body?.cookie === "string" ? body.cookie.trim() : "";
  const noteIds = normalizeJobNoteIds(body?.noteIds);
  const notebookId = typeof body?.notebookId === "string" && body.notebookId.trim()
    ? body.notebookId.trim()
    : undefined;

  if (!cookie) return c.json({ error: "缺少 Cookie", code: "COOKIE_REQUIRED" }, 400);
  if (noteIds.length === 0) return c.json({ error: "请选择要导入的笔记", code: "NOTES_REQUIRED" }, 400);

  const active = findActiveJob(userId);
  if (active) {
    return c.json({
      error: "已有小米笔记导入任务正在运行",
      code: "MICLOUD_IMPORT_JOB_ACTIVE",
      job: toSnapshot(active),
    }, 409);
  }

  try {
    return c.json({ job: createJobRecord({ userId, cookie, noteIds, notebookId }) }, 202);
  } catch (error) {
    const detail = safeText(error instanceof Error ? error.message : error, "创建导入任务失败");
    const code = (error as { code?: unknown } | null)?.code;
    return c.json({
      error: detail,
      code: typeof code === "string" ? code : "MICLOUD_IMPORT_JOB_CREATE_FAILED",
    }, detail.includes("无写入权限") ? 403 : 500);
  }
}

function getActiveImportJob(c: Context) {
  const userId = requireUserId(c);
  if (!userId) return c.json({ error: "未授权", code: "UNAUTHENTICATED" }, 401);
  const active = findActiveJob(userId);
  return c.json({ job: active ? toSnapshot(active) : null });
}

function getImportJob(c: Context) {
  const userId = requireUserId(c);
  if (!userId) return c.json({ error: "未授权", code: "UNAUTHENTICATED" }, 401);
  const row = getOwnedJobRow(c.req.param("jobId"), userId);
  if (!row) return c.json({ error: "导入任务不存在", code: "JOB_NOT_FOUND" }, 404);
  return c.json({ job: toSnapshot(row) });
}

function streamImportJob(c: Context) {
  const userId = requireUserId(c);
  if (!userId) return c.json({ error: "未授权", code: "UNAUTHENTICATED" }, 401);
  const jobId = c.req.param("jobId");
  if (!getOwnedJobRow(jobId, userId)) {
    return c.json({ error: "导入任务不存在", code: "JOB_NOT_FOUND" }, 404);
  }

  return streamSSE(c, async (stream) => {
    let aborted = false;
    let lastVersion = "";
    stream.onAbort(() => { aborted = true; });

    while (!aborted) {
      const row = getOwnedJobRow(jobId, userId);
      if (!row) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: "导入任务不存在", code: "JOB_NOT_FOUND" }),
        });
        break;
      }

      const version = `${row.updatedAt}:${row.processed}:${row.status}`;
      if (version !== lastVersion) {
        await stream.writeSSE({
          id: version,
          event: isTerminal(row.status) ? "done" : "progress",
          data: JSON.stringify(toSnapshot(row)),
        });
        lastVersion = version;
        if (isTerminal(row.status)) break;
      }

      if (await waitForJobSignal(jobId) === "heartbeat" && !aborted) {
        await stream.writeSSE({
          event: "heartbeat",
          data: JSON.stringify({ at: new Date().toISOString() }),
        });
      }
    }
  });
}

function cancelImportJob(c: Context) {
  const userId = requireUserId(c);
  if (!userId) return c.json({ error: "未授权", code: "UNAUTHENTICATED" }, 401);
  const jobId = c.req.param("jobId");
  const row = getOwnedJobRow(jobId, userId);
  if (!row) return c.json({ error: "导入任务不存在", code: "JOB_NOT_FOUND" }, 404);

  if (!isTerminal(row.status)) {
    getDb().prepare(`
      UPDATE micloud_import_jobs
      SET cancelRequested = 1, status = 'cancelling', updatedAt = datetime('now')
      WHERE id = ?
    `).run(jobId);
    notifyJob(jobId);
  }
  const updated = getOwnedJobRow(jobId, userId);
  return c.json({ job: toSnapshot(updated || row) });
}

async function retryFailedImportJob(c: Context) {
  const userId = requireUserId(c);
  if (!userId) return c.json({ error: "未授权", code: "UNAUTHENTICATED" }, 401);
  const originalId = c.req.param("jobId");
  const original = getOwnedJobRow(originalId, userId);
  if (!original) return c.json({ error: "导入任务不存在", code: "JOB_NOT_FOUND" }, 404);
  if (!isTerminal(original.status) || original.failed === 0) {
    return c.json({ error: "该任务没有可重试的失败项", code: "NO_FAILED_ITEMS" }, 409);
  }

  const body = await c.req.json().catch(() => null) as { cookie?: unknown } | null;
  const cookie = typeof body?.cookie === "string" ? body.cookie.trim() : "";
  if (!cookie) return c.json({ error: "缺少 Cookie", code: "COOKIE_REQUIRED" }, 400);

  const active = findActiveJob(userId);
  if (active) {
    return c.json({
      error: "已有小米笔记导入任务正在运行",
      code: "MICLOUD_IMPORT_JOB_ACTIVE",
      job: toSnapshot(active),
    }, 409);
  }

  const failedItems = getDb().prepare(`
    SELECT externalId FROM micloud_import_job_items
    WHERE jobId = ? AND status = 'failed'
    ORDER BY sequence
  `).all(originalId) as Array<{ externalId: string }>;

  try {
    const job = createJobRecord({
      userId,
      cookie,
      noteIds: failedItems.map((item) => item.externalId),
      notebookId: original.notebookId,
      retryOfJobId: originalId,
    });
    return c.json({ job }, 202);
  } catch (error) {
    return c.json({
      error: safeText(error instanceof Error ? error.message : error, "重试任务创建失败"),
      code: "MICLOUD_IMPORT_RETRY_FAILED",
    }, 500);
  }
}

export function installMiCloudImportJobs(root: Hono<any>): void {
  const taggedRoot = root as Hono<any> & Record<symbol, boolean>;
  if (taggedRoot[ROUTER_INSTALLED_FLAG]) return;
  taggedRoot[ROUTER_INSTALLED_FLAG] = true;
  recoverInterruptedJobs();
  root.post("/api/micloud/import-jobs", createImportJob);
  root.get("/api/micloud/import-jobs/active", getActiveImportJob);
  root.get("/api/micloud/import-jobs/:jobId/events", streamImportJob);
  root.get("/api/micloud/import-jobs/:jobId", getImportJob);
  root.post("/api/micloud/import-jobs/:jobId/cancel", cancelImportJob);
  root.post("/api/micloud/import-jobs/:jobId/retry-failed", retryFailedImportJob);
}

const globals = globalThis as typeof globalThis & Record<symbol, boolean>;
if (!globals[ROUTE_PATCH_FLAG]) {
  globals[ROUTE_PATCH_FLAG] = true;
  const prototype = Hono.prototype as any;
  const nativeRoute = prototype.route as (this: Hono<any>, path: string, subApp: Hono<any>) => Hono<any>;
  prototype.route = function patchedRoute(this: Hono<any>, path: string, subApp: Hono<any>) {
    if (path === "/api/micloud") installMiCloudImportJobs(this);
    return nativeRoute.call(this, path, subApp);
  };
}
