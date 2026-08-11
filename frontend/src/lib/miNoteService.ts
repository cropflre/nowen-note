import { api, getBaseUrl } from "./api";

export interface MiNoteEntry {
  id: string;
  rowKey: string;
  title: string;
  snippet: string;
  folderId: string;
  folderName: string;
  createDate: number;
  modifyDate: number;
  colorId: number;
  selected: boolean;
}

export type MiCloudImportJobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export interface MiCloudImportJob {
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
}

export interface MiCloudImportResult {
  success: boolean;
  count: number;
  failedCount: number;
  errors: string[];
  jobId?: string;
  cancelled?: boolean;
}

export interface MiCloudState {
  phase: "idle" | "verifying" | "loading" | "ready" | "importing" | "done" | "error";
  message: string;
  notes: MiNoteEntry[];
  folders: Record<string, string>;
  importedCount: number;
}

const MI_CLOUD_COOKIE_KEY = "mi-cloud-cookie";
const MI_CLOUD_ACTIVE_JOB_KEY = "mi-cloud-active-import-job";
const SSE_RECONNECT_LIMIT = 5;

export function saveMiCookie(cookie: string) {
  try {
    sessionStorage.setItem(MI_CLOUD_COOKIE_KEY, cookie);
  } catch {
    // 受限 WebView 中 sessionStorage 可能不可用，本次会话仍可继续导入。
  }
}

export function getMiCookie(): string {
  try {
    return sessionStorage.getItem(MI_CLOUD_COOKIE_KEY) || "";
  } catch {
    return "";
  }
}

export function clearMiCookie() {
  try {
    sessionStorage.removeItem(MI_CLOUD_COOKIE_KEY);
  } catch {
    // ignore
  }
}

function rememberActiveJob(jobId: string | null): void {
  try {
    if (jobId) sessionStorage.setItem(MI_CLOUD_ACTIVE_JOB_KEY, jobId);
    else sessionStorage.removeItem(MI_CLOUD_ACTIVE_JOB_KEY);
  } catch {
    // ignore
  }
}

export async function verifyMiCookie(cookie: string): Promise<{ valid: boolean; error?: string }> {
  return api.miCloudVerify(cookie);
}

export async function fetchMiNotes(cookie: string): Promise<{
  notes: MiNoteEntry[];
  folders: Record<string, string>;
}> {
  const res = await api.miCloudNotes(cookie);
  return {
    notes: res.notes.map((note: any, index: number) => ({
      ...note,
      rowKey: `${String(note.id)}:${index}`,
      selected: true,
    })),
    folders: res.folders,
  };
}

function readAuthToken(): string | null {
  try {
    return localStorage.getItem("nowen-token");
  } catch {
    return null;
  }
}

function requestHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = readAuthToken();
  return {
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function isTerminal(status: MiCloudImportJobStatus): boolean {
  return status === "completed"
    || status === "partial"
    || status === "failed"
    || status === "cancelled";
}

function errorMessage(payload: any, fallback: string): string {
  return typeof payload?.error === "string" && payload.error.trim()
    ? payload.error.trim()
    : fallback;
}

async function createMiCloudImportJob(
  cookie: string,
  noteIds: string[],
  notebookId?: string,
): Promise<MiCloudImportJob> {
  const response = await fetch(`${getBaseUrl()}/micloud/import-jobs`, {
    method: "POST",
    headers: requestHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ cookie, noteIds, notebookId }),
  });
  const payload = await response.json().catch(() => ({})) as {
    job?: MiCloudImportJob;
    error?: string;
  };

  if (response.status === 409 && payload.job) return payload.job;
  if (!response.ok || !payload.job) {
    throw new Error(errorMessage(payload, `创建小米导入任务失败: ${response.status}`));
  }
  return payload.job;
}

async function getMiCloudImportJob(jobId: string): Promise<MiCloudImportJob> {
  const response = await fetch(`${getBaseUrl()}/micloud/import-jobs/${encodeURIComponent(jobId)}`, {
    headers: requestHeaders(),
  });
  const payload = await response.json().catch(() => ({})) as {
    job?: MiCloudImportJob;
    error?: string;
  };
  if (!response.ok || !payload.job) {
    throw new Error(errorMessage(payload, `读取小米导入任务失败: ${response.status}`));
  }
  return payload.job;
}

async function getActiveMiCloudImportJob(): Promise<MiCloudImportJob | null> {
  const response = await fetch(`${getBaseUrl()}/micloud/import-jobs/active`, {
    headers: requestHeaders(),
  });
  const payload = await response.json().catch(() => ({})) as {
    job?: MiCloudImportJob | null;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(errorMessage(payload, `读取小米导入任务失败: ${response.status}`));
  }
  return payload.job || null;
}

function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length > 0 ? { event, data: data.join("\n") } : null;
}

async function consumeJobSse(
  response: Response,
  onProgress?: (job: MiCloudImportJob) => void,
): Promise<MiCloudImportJob | null> {
  if (!response.body) throw new Error("浏览器不支持流式导入进度");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let latest: MiCloudImportJob | null = null;

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseBlock(raw);
      if (event && event.event !== "heartbeat") {
        const parsed = JSON.parse(event.data) as MiCloudImportJob;
        latest = parsed;
        onProgress?.(parsed);
        if (isTerminal(parsed.status)) {
          await reader.cancel().catch(() => undefined);
          return parsed;
        }
      }
      boundary = buffer.indexOf("\n\n");
    }

    if (done) break;
  }

  return latest;
}

async function followMiCloudImportJob(
  jobId: string,
  initial: MiCloudImportJob,
  onProgress?: (job: MiCloudImportJob) => void,
): Promise<MiCloudImportJob> {
  let latest = initial;
  onProgress?.(latest);

  for (let attempt = 0; attempt <= SSE_RECONNECT_LIMIT; attempt += 1) {
    if (isTerminal(latest.status)) return latest;
    try {
      const response = await fetch(
        `${getBaseUrl()}/micloud/import-jobs/${encodeURIComponent(jobId)}/events`,
        {
          headers: requestHeaders({ Accept: "text/event-stream" }),
          cache: "no-store",
        },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(errorMessage(payload, `连接导入进度失败: ${response.status}`));
      }
      const streamed = await consumeJobSse(response, onProgress);
      if (streamed) latest = streamed;
      if (isTerminal(latest.status)) return latest;
    } catch (error) {
      if (attempt >= SSE_RECONNECT_LIMIT) {
        const final = await getMiCloudImportJob(jobId);
        onProgress?.(final);
        if (isTerminal(final.status)) return final;
        throw new Error(
          `导入任务仍在后台运行，但进度连接已中断：${
            error instanceof Error ? error.message : String(error || "网络错误")
          }`,
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000 * (attempt + 1), 5_000)));
    latest = await getMiCloudImportJob(jobId);
    onProgress?.(latest);
  }

  return latest;
}

function jobToResult(job: MiCloudImportJob): MiCloudImportResult {
  const errors = job.errors?.length
    ? job.errors
    : job.error
      ? [job.error]
      : [];
  return {
    success: job.succeeded > 0 && (job.status === "completed" || job.status === "partial"),
    count: job.succeeded,
    failedCount: job.failed,
    errors,
    jobId: job.id,
    cancelled: job.status === "cancelled",
  };
}

export async function importMiNotes(
  cookie: string,
  noteIds: string[],
  notebookId?: string,
  onProgress?: (job: MiCloudImportJob) => void,
): Promise<MiCloudImportResult> {
  const rows = noteIds
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean);
  if (rows.length === 0) {
    return { success: false, count: 0, failedCount: 0, errors: ["请选择要导入的笔记"] };
  }

  const job = await createMiCloudImportJob(cookie, rows, notebookId);
  rememberActiveJob(job.id);
  try {
    return jobToResult(await followMiCloudImportJob(job.id, job, onProgress));
  } finally {
    rememberActiveJob(null);
  }
}

export async function resumeActiveMiCloudImport(
  onProgress?: (job: MiCloudImportJob) => void,
): Promise<MiCloudImportResult | null> {
  const active = await getActiveMiCloudImportJob();
  if (!active) {
    rememberActiveJob(null);
    return null;
  }
  rememberActiveJob(active.id);
  try {
    return jobToResult(await followMiCloudImportJob(active.id, active, onProgress));
  } finally {
    rememberActiveJob(null);
  }
}

export async function cancelMiCloudImport(jobId: string): Promise<MiCloudImportJob> {
  const response = await fetch(
    `${getBaseUrl()}/micloud/import-jobs/${encodeURIComponent(jobId)}/cancel`,
    {
      method: "POST",
      headers: requestHeaders({ "Content-Type": "application/json" }),
      body: "{}",
    },
  );
  const payload = await response.json().catch(() => ({})) as {
    job?: MiCloudImportJob;
    error?: string;
  };
  if (!response.ok || !payload.job) {
    throw new Error(errorMessage(payload, `取消导入失败: ${response.status}`));
  }
  return payload.job;
}

export async function retryFailedMiCloudImport(
  jobId: string,
  cookie: string,
  onProgress?: (job: MiCloudImportJob) => void,
): Promise<MiCloudImportResult> {
  const response = await fetch(
    `${getBaseUrl()}/micloud/import-jobs/${encodeURIComponent(jobId)}/retry-failed`,
    {
      method: "POST",
      headers: requestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ cookie }),
    },
  );
  const payload = await response.json().catch(() => ({})) as {
    job?: MiCloudImportJob;
    error?: string;
  };
  if (response.status === 409 && payload.job) {
    return jobToResult(await followMiCloudImportJob(payload.job.id, payload.job, onProgress));
  }
  if (!response.ok || !payload.job) {
    throw new Error(errorMessage(payload, `重试失败项失败: ${response.status}`));
  }

  rememberActiveJob(payload.job.id);
  try {
    return jobToResult(await followMiCloudImportJob(payload.job.id, payload.job, onProgress));
  } finally {
    rememberActiveJob(null);
  }
}
