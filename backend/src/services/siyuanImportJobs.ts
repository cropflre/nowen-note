import crypto from "node:crypto";
import fs from "node:fs";
import { getDb } from "../db/schema";
import { broadcastToUser } from "./realtime";
import type { SiyuanPackageImportResult } from "./siyuanPackageImport";

export type SiyuanImportJobStatus = "queued" | "running" | "completed" | "failed";

type SiyuanImportJobRow = {
  id: string;
  requestId: string;
  userId: string;
  workspaceId: string | null;
  targetNotebookId: string | null;
  contentFormat: "tiptap-json" | "markdown";
  fingerprint: string;
  filename: string;
  size: number;
  tmpDir: string;
  tmpPath: string;
  status: SiyuanImportJobStatus;
  phase: string;
  message: string;
  resultJson: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

export type SiyuanImportJobResult = Omit<SiyuanPackageImportResult, "notes"> & {
  notes: [];
};

export type SiyuanImportJobSnapshot = {
  id: string;
  requestId: string;
  status: SiyuanImportJobStatus;
  phase: string;
  message: string;
  filename: string;
  size: number;
  contentFormat: "tiptap-json" | "markdown";
  workspaceId: string | null;
  targetNotebookId: string | null;
  result: SiyuanImportJobResult | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

type RuntimeState = {
  runningJobs: Set<string>;
  scheduledJobs: Set<string>;
  schemaReady: boolean;
};

const runtimeGlobals = globalThis as typeof globalThis & {
  __nowenSiyuanImportJobs?: RuntimeState;
};
const runtime = runtimeGlobals.__nowenSiyuanImportJobs ||= {
  runningJobs: new Set<string>(),
  scheduledJobs: new Set<string>(),
  schemaReady: false,
};
runtime.scheduledJobs ||= new Set<string>();
const STALE_RUNNING_JOB_MINUTES = 10;

function ensureSchema(): void {
  if (runtime.schemaReady) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS siyuan_import_jobs (
      id TEXT PRIMARY KEY,
      requestId TEXT NOT NULL,
      userId TEXT NOT NULL,
      workspaceId TEXT,
      targetNotebookId TEXT,
      contentFormat TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      filename TEXT NOT NULL,
      size INTEGER NOT NULL,
      tmpDir TEXT NOT NULL,
      tmpPath TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      phase TEXT NOT NULL DEFAULT 'queued',
      message TEXT NOT NULL DEFAULT '等待后台导入',
      resultJson TEXT,
      error TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      startedAt TEXT,
      finishedAt TEXT,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(userId, requestId)
    );

    CREATE INDEX IF NOT EXISTS idx_siyuan_import_jobs_fingerprint
      ON siyuan_import_jobs(userId, fingerprint, status, createdAt);
    CREATE INDEX IF NOT EXISTS idx_siyuan_import_jobs_user_status
      ON siyuan_import_jobs(userId, status, createdAt);
  `);
  runtime.schemaReady = true;
}

function readRow(jobId: string): SiyuanImportJobRow | undefined {
  ensureSchema();
  return getDb().prepare(`
    SELECT id, requestId, userId, workspaceId, targetNotebookId, contentFormat,
           fingerprint, filename, size, tmpDir, tmpPath, status, phase, message,
           resultJson, error, createdAt, startedAt, finishedAt, updatedAt
    FROM siyuan_import_jobs
    WHERE id = ?
  `).get(jobId) as SiyuanImportJobRow | undefined;
}

function readOwnedRow(jobId: string, userId: string): SiyuanImportJobRow | undefined {
  const row = readRow(jobId);
  return row?.userId === userId ? row : undefined;
}

function parseResult(value: string | null): SiyuanImportJobResult | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as SiyuanImportJobResult;
  } catch {
    return null;
  }
}

function toSnapshot(row: SiyuanImportJobRow): SiyuanImportJobSnapshot {
  return {
    id: row.id,
    requestId: row.requestId,
    status: row.status,
    phase: row.phase,
    message: row.message,
    filename: row.filename,
    size: row.size,
    contentFormat: row.contentFormat,
    workspaceId: row.workspaceId,
    targetNotebookId: row.targetNotebookId,
    result: parseResult(row.resultJson),
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    updatedAt: row.updatedAt,
  };
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error || "思源导入失败");
  return text.replace(/\s+/g, " ").trim().slice(0, 2_000) || "思源导入失败";
}

function queueJob(jobId: string): void {
  if (runtime.runningJobs.has(jobId) || runtime.scheduledJobs.has(jobId)) return;
  runtime.scheduledJobs.add(jobId);
  setImmediate(() => {
    void processJob(jobId).catch((error) => {
      console.error("[siyuan-import-jobs] unhandled worker error", {
        jobId,
        error: safeError(error),
      });
    });
  });
}

async function removeJobUpload(row: Pick<SiyuanImportJobRow, "tmpDir">): Promise<void> {
  try {
    await fs.promises.rm(row.tmpDir, { recursive: true, force: true });
  } catch {
    /* 临时目录另有定时清理兜底。 */
  }
}

function compactResult(result: SiyuanPackageImportResult): SiyuanImportJobResult {
  return {
    ...result,
    notes: [],
  };
}

async function processJob(jobId: string): Promise<void> {
  runtime.scheduledJobs.delete(jobId);
  if (runtime.runningJobs.has(jobId)) return;
  runtime.runningJobs.add(jobId);
  let row: SiyuanImportJobRow | undefined;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let claimedJob = false;

  try {
    row = readRow(jobId);
    if (!row || row.status !== "queued") return;

    const claimed = getDb().prepare(`
      UPDATE siyuan_import_jobs
      SET status = 'running', phase = 'importing',
          message = '正在解析数据包并导入目录、笔记和附件',
          startedAt = COALESCE(startedAt, datetime('now')),
          updatedAt = datetime('now')
      WHERE id = ? AND status = 'queued'
    `).run(jobId);
    if (claimed.changes !== 1) return;
    claimedJob = true;
    if (!fs.existsSync(row.tmpPath)) throw new Error("思源导入包临时文件不存在，请重新上传");

    heartbeat = setInterval(() => {
      try {
        getDb().prepare(`
          UPDATE siyuan_import_jobs
          SET updatedAt = datetime('now')
          WHERE id = ? AND status = 'running'
        `).run(jobId);
      } catch {
        /* 最终状态写入仍负责记录真实成败，心跳失败不应中断导入。 */
      }
    }, 15_000);

    const { importSiyuanPackageFromZipFile } = await import("./siyuanPackageImport");
    const result = await importSiyuanPackageFromZipFile(row.tmpPath, {
      userId: row.userId,
      workspaceId: row.workspaceId,
      targetNotebookId: row.targetNotebookId || undefined,
      contentFormat: row.contentFormat,
    });
    const parsedNotes = result.stats.parsedNotes ?? result.stats.syFiles;
    const createdNotes = result.stats.createdNotes ?? result.count;
    const failedNotes = result.stats.failedNotes ?? Math.max(0, parsedNotes - createdNotes);
    if (!result.success || createdNotes <= 0 || createdNotes !== result.count || failedNotes > 0) {
      throw new Error(`已成功解析 ${parsedNotes} 篇思源文档，但 ${createdNotes} 篇写入成功，${failedNotes} 篇失败`);
    }
    const compact = compactResult(result);

    getDb().prepare(`
      UPDATE siyuan_import_jobs
      SET status = 'completed', phase = 'completed', message = ?,
          resultJson = ?, error = NULL,
          finishedAt = datetime('now'), updatedAt = datetime('now')
      WHERE id = ?
    `).run(
      `已解析 ${parsedNotes} 篇，成功写入 ${createdNotes} 篇，创建目录 ${result.stats.createdFolders} 个，附件 ${result.stats.createdAttachments} 个`,
      JSON.stringify(compact),
      jobId,
    );

    try {
      broadcastToUser(row.userId, {
        type: "notes:imported" as any,
        count: result.count,
        notebookIds: result.notebookIds,
        workspaceId: row.workspaceId,
      });
    } catch (error) {
      console.warn("[siyuan-import-jobs] broadcast failed", { jobId, error: safeError(error) });
    }
  } catch (error) {
    const detail = safeError(error);
    try {
      getDb().prepare(`
        UPDATE siyuan_import_jobs
        SET status = 'failed', phase = 'failed', message = ?, error = ?,
            finishedAt = datetime('now'), updatedAt = datetime('now')
        WHERE id = ?
      `).run(detail, detail, jobId);
    } catch (updateError) {
      console.error("[siyuan-import-jobs] failed to persist job failure", {
        jobId,
        error: safeError(updateError),
      });
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (row && claimedJob) await removeJobUpload(row);
    runtime.runningJobs.delete(jobId);
  }
}

function resumeIfNeeded(row: SiyuanImportJobRow): SiyuanImportJobRow {
  if (row.status === "queued") {
    queueJob(row.id);
    return row;
  }
  if (
    row.status !== "running"
    || runtime.runningJobs.has(row.id)
    || runtime.scheduledJobs.has(row.id)
  ) return row;

  const detail = "思源导入执行进程已中断，为避免重复写入已停止自动重跑；请重新发起导入";
  const stopped = getDb().prepare(`
    UPDATE siyuan_import_jobs
    SET status = 'failed', phase = 'failed', message = ?, error = ?,
        finishedAt = datetime('now'), updatedAt = datetime('now')
    WHERE id = ? AND status = 'running'
      AND updatedAt <= datetime('now', ?)
  `).run(detail, detail, row.id, `-${STALE_RUNNING_JOB_MINUTES} minutes`);
  return stopped.changes === 1 ? readRow(row.id) || row : row;
}

export function getSiyuanImportJob(jobId: string, userId: string): SiyuanImportJobSnapshot | null {
  const row = readOwnedRow(jobId, userId);
  if (!row) return null;
  return toSnapshot(resumeIfNeeded(row));
}

export function getSiyuanImportJobByRequestId(
  requestId: string,
  userId: string,
): SiyuanImportJobSnapshot | null {
  ensureSchema();
  const row = getDb().prepare(`
    SELECT id, requestId, userId, workspaceId, targetNotebookId, contentFormat,
           fingerprint, filename, size, tmpDir, tmpPath, status, phase, message,
           resultJson, error, createdAt, startedAt, finishedAt, updatedAt
    FROM siyuan_import_jobs
    WHERE userId = ? AND requestId = ?
    LIMIT 1
  `).get(userId, requestId) as SiyuanImportJobRow | undefined;
  if (!row) return null;
  return toSnapshot(resumeIfNeeded(row));
}

function findActiveDuplicate(input: {
  userId: string;
  workspaceId: string | null;
  targetNotebookId?: string;
  contentFormat: "tiptap-json" | "markdown";
  fingerprint: string;
}): SiyuanImportJobRow | undefined {
  ensureSchema();
  return getDb().prepare(`
    SELECT id, requestId, userId, workspaceId, targetNotebookId, contentFormat,
           fingerprint, filename, size, tmpDir, tmpPath, status, phase, message,
           resultJson, error, createdAt, startedAt, finishedAt, updatedAt
    FROM siyuan_import_jobs
    WHERE userId = ?
      AND workspaceId IS ?
      AND targetNotebookId IS ?
      AND contentFormat = ?
      AND fingerprint = ?
      AND status IN ('queued', 'running')
      AND createdAt >= datetime('now', '-1 day')
    ORDER BY createdAt DESC
    LIMIT 1
  `).get(
    input.userId,
    input.workspaceId,
    input.targetNotebookId || null,
    input.contentFormat,
    input.fingerprint,
  ) as SiyuanImportJobRow | undefined;
}

export async function createSiyuanImportJob(input: {
  requestId: string;
  userId: string;
  workspaceId: string | null;
  targetNotebookId?: string;
  contentFormat: "tiptap-json" | "markdown";
  fingerprint: string;
  filename: string;
  size: number;
  tmpDir: string;
  tmpPath: string;
}): Promise<{ job: SiyuanImportJobSnapshot; reused: boolean }> {
  ensureSchema();

  const requestMatch = getSiyuanImportJobByRequestId(input.requestId, input.userId);
  if (requestMatch) {
    await removeJobUpload(input);
    return { job: requestMatch, reused: true };
  }

  // requestId 负责同一次请求重试的幂等；文件指纹只合并仍在执行的任务。
  // 已完成的导入可能已被用户删除或移动，再次主动导入必须创建新任务。
  const duplicate = findActiveDuplicate(input);
  if (duplicate) {
    await removeJobUpload(input);
    resumeIfNeeded(duplicate);
    return { job: toSnapshot(duplicate), reused: true };
  }

  const id = crypto.randomUUID();
  try {
    getDb().prepare(`
      INSERT INTO siyuan_import_jobs (
        id, requestId, userId, workspaceId, targetNotebookId, contentFormat,
        fingerprint, filename, size, tmpDir, tmpPath
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.requestId,
      input.userId,
      input.workspaceId,
      input.targetNotebookId || null,
      input.contentFormat,
      input.fingerprint,
      input.filename,
      input.size,
      input.tmpDir,
      input.tmpPath,
    );
  } catch (error) {
    const concurrent = getSiyuanImportJobByRequestId(input.requestId, input.userId);
    if (!concurrent) throw error;
    await removeJobUpload(input);
    return { job: concurrent, reused: true };
  }

  queueJob(id);
  const row = readRow(id);
  if (!row) throw new Error("思源导入任务创建后无法读取");
  return { job: toSnapshot(row), reused: false };
}
