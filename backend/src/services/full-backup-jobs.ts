import crypto from "crypto";
import type { BackupInfo } from "./backup";

const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000;

export interface FullBackupJobSnapshot {
  id: string;
  state: "queued" | "running" | "ready" | "error";
  message: string;
  createdAt: string;
  updatedAt: string;
  backup?: BackupInfo;
  downloadToken?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}

interface FullBackupJob extends FullBackupJobSnapshot {
  expiresAt: number;
  description?: string;
}

type CreateFullBackup = (description?: string) => Promise<BackupInfo>;

/** Public-facing diagnosis: stable error codes and allowlisted messages only. */
export function classifyFullBackupJobError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const typed = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof typed?.code === "string" ? typed.code
    : typeof typed?.cause?.code === "string" ? typed.cause.code : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "ENOSPC" || code === "EDQUOT" || /磁盘空间不足|no space left on device/i.test(message)) {
    return { code: "BACKUP_STORAGE_NO_SPACE", message: "磁盘空间不足", retryable: false };
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return { code: "BACKUP_STORAGE_PERMISSION_DENIED", message: "备份目录没有写入权限", retryable: false };
  }
  // Do not expose arbitrary upstream exception messages, private paths, or SQL.
  return { code: "BACKUP_JOB_FAILED", message: "完整备份生成失败，请检查服务器日志", retryable: false };
}

function snapshot(job: FullBackupJob): FullBackupJobSnapshot {
  const { expiresAt: _expiresAt, description: _description, ...publicJob } = job;
  return { ...publicJob };
}

export class FullBackupJobBusyError extends Error {
  readonly code = "FULL_BACKUP_JOB_BUSY";

  constructor() {
    super("已有其他完整备份正在生成，请等待当前任务完成");
  }
}

/**
 * 保存短生命周期的完整备份任务状态。任务文件仍由 BackupManager 管理，
 * 此处只负责让 HTTP 请求快速返回并提供轮询状态。
 */
export class FullBackupJobStore {
  private readonly jobs = new Map<string, FullBackupJob>();
  private readonly downloadTokens = new Map<string, string>();
  private activeJobId: string | null = null;

  constructor(
    private readonly createFullBackup: CreateFullBackup,
    private readonly ttlMs = DEFAULT_JOB_TTL_MS,
  ) {}

  start(description?: string): FullBackupJobSnapshot {
    this.cleanup();
    if (this.activeJobId) {
      const active = this.jobs.get(this.activeJobId);
      if (active && (active.state === "queued" || active.state === "running")) {
        if (active.description === description) return snapshot(active);
        throw new FullBackupJobBusyError();
      }
      this.activeJobId = null;
    }

    const now = new Date().toISOString();
    const job: FullBackupJob = {
      id: crypto.randomUUID(),
      state: "queued",
      message: "完整备份已排队",
      createdAt: now,
      updatedAt: now,
      expiresAt: Date.now() + this.ttlMs,
      description,
    };
    this.jobs.set(job.id, job);
    this.activeJobId = job.id;

    setImmediate(() => void this.run(job, description));
    return snapshot(job);
  }

  get(id: string): FullBackupJobSnapshot | null {
    this.cleanup();
    const job = this.jobs.get(id);
    return job ? snapshot(job) : null;
  }

  getByDownloadToken(token: string): FullBackupJobSnapshot | null {
    this.cleanup();
    const jobId = this.downloadTokens.get(token);
    const job = jobId ? this.jobs.get(jobId) : undefined;
    if (!job || job.state !== "ready" || job.downloadToken !== token) return null;
    return snapshot(job);
  }

  private async run(job: FullBackupJob, description?: string): Promise<void> {
    job.state = "running";
    job.message = "正在流式生成完整备份";
    job.updatedAt = new Date().toISOString();
    try {
      job.backup = await this.createFullBackup(description);
      job.downloadToken = crypto.randomBytes(32).toString("hex");
      this.downloadTokens.set(job.downloadToken, job.id);
      job.state = "ready";
      job.message = "完整备份已生成";
    } catch (error) {
      const failure = classifyFullBackupJobError(error);
      job.state = "error";
      job.message = "完整备份生成失败";
      job.error = failure.message;
      job.errorCode = failure.code;
      job.retryable = failure.retryable;
      // Error details may contain private note content, filesystem paths or
      // credentials. Log only a safe classification, correlated to the job ID.
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "ERROR",
        event: "backup.full-job.failed",
        module: "backup",
        operationId: job.id,
        code: failure.code,
      }));
    } finally {
      job.updatedAt = new Date().toISOString();
      job.expiresAt = Date.now() + this.ttlMs;
      if (this.activeJobId === job.id) this.activeJobId = null;
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.expiresAt <= now && id !== this.activeJobId) {
        if (job.downloadToken) this.downloadTokens.delete(job.downloadToken);
        this.jobs.delete(id);
      }
    }
  }
}
