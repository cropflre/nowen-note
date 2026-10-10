export interface FullBackupJobResult {
  filename: string;
  size: number;
  downloadToken?: string;
}

interface FullBackupJobSnapshot {
  id: string;
  state: "queued" | "running" | "ready" | "error";
  message: string;
  backup?: FullBackupJobResult;
  downloadToken?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}

interface FullBackupJobApi {
  start: (sudoToken?: string, description?: string) => Promise<FullBackupJobSnapshot>;
  get: (jobId: string) => Promise<FullBackupJobSnapshot>;
}

interface FullBackupJobRunOptions {
  delay?: () => Promise<void>;
  onStatus?: (message: string) => void;
}

const defaultDelay = () => new Promise<void>((resolve) => window.setTimeout(resolve, 1_000));

/** 启动完整备份后台任务，并通过短轮询等待生成结果。 */
export async function runFullBackupJob(
  client: FullBackupJobApi,
  sudoToken?: string,
  description?: string,
  options: FullBackupJobRunOptions = {},
): Promise<FullBackupJobResult> {
  const delay = options.delay || defaultDelay;
  let job = await client.start(sudoToken, description);

  while (true) {
    options.onStatus?.(job.message);
    if (job.state === "ready") {
      if (!job.backup?.filename) throw new Error("完整备份已生成，但服务端未返回下载文件");
      return { ...job.backup, downloadToken: job.downloadToken };
    }
    if (job.state === "error") {
      const error = new Error(job.error || job.message || "完整备份生成失败") as Error & {
        code?: string;
        operationId: string;
        retryable: boolean;
      };
      error.code = job.errorCode || "BACKUP_JOB_FAILED";
      error.operationId = job.id;
      error.retryable = job.retryable === true;
      throw error;
    }
    await delay();
    job = await client.get(job.id);
  }
}
