import { getBaseUrl } from "@/lib/api";

export type RemoteImageLocalizationJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_errors"
  | "cancelled"
  | "failed";

export type RemoteImageLocalizationNoteStatus =
  | "queued"
  | "completed"
  | "partial"
  | "failed"
  | "skipped"
  | "forbidden"
  | "locked"
  | "trashed"
  | "conflict"
  | "parse_error";

export interface RemoteImageLocalizationFailure {
  noteId: string;
  url?: string;
  code: string;
  message: string;
}

export interface RemoteImageLocalizationScanNote {
  noteId: string;
  title: string;
  version: number;
  contentFormat: string;
  status: "ready" | "forbidden" | "locked" | "trashed" | "conflict" | "parse_error" | "not_found";
  reason?: string;
  scan: {
    contentFormat: string;
    totalImageReferences: number;
    remoteReferenceCount: number;
    localReferenceCount: number;
    ignoredReferenceCount: number;
    remoteUrls: string[];
    parseError?: string;
  };
}

export interface RemoteImageLocalizationScan {
  noteCount: number;
  readyNoteCount: number;
  notesWithRemoteImages: number;
  totalImageReferences: number;
  remoteReferenceCount: number;
  localReferenceCount: number;
  ignoredReferenceCount: number;
  uniqueRemoteUrlCount: number;
  uniqueRemoteUrls: string[];
  skippedNoteCount: number;
  notes: RemoteImageLocalizationScanNote[];
  limits: {
    maxNotes: number;
    maxImages: number;
    maxTotalBytes: number;
  };
}

export interface RemoteImageLocalizationNoteResult {
  noteId: string;
  title: string;
  scannedVersion: number;
  finalVersion?: number;
  status: RemoteImageLocalizationNoteStatus;
  remoteReferenceCount: number;
  uniqueRemoteUrlCount: number;
  localizedReferences: number;
  localizedUrls: number;
  deduplicatedAttachments: number;
  failedUrls: number;
  skippedUrls: number;
  failures: RemoteImageLocalizationFailure[];
  warnings: string[];
}

export interface RemoteImageLocalizationJob {
  id: string;
  status: RemoteImageLocalizationJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelRequested: boolean;
  source: "note_ids" | "notebook";
  notebookId: string | null;
  noteIds: string[];
  currentNoteId: string | null;
  currentNoteTitle: string | null;
  currentUrl: string | null;
  error: string | null;
  summary: {
    totalNotes: number;
    scannedNotes: number;
    processedNotes: number;
    updatedNotes: number;
    skippedNotes: number;
    conflictNotes: number;
    notesWithFailures: number;
    totalImageReferences: number;
    remoteReferenceCount: number;
    uniqueRemoteUrlCount: number;
    downloadedUniqueUrls: number;
    reusedDownloads: number;
    localizedReferences: number;
    localizedUrls: number;
    deduplicatedAttachments: number;
    failedUrls: number;
    downloadedBytes: number;
  };
  noteResults: RemoteImageLocalizationNoteResult[];
  failures: RemoteImageLocalizationFailure[];
}

export type RemoteImageLocalizationScope =
  | { noteIds: string[]; expectedVersions?: Record<string, number> }
  | { notebookId: string; expectedVersions?: Record<string, number> };

async function authenticatedJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("nowen-token");
  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const error = new Error(
      typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`,
    ) as Error & { code?: string; status?: number };
    error.code = payload?.code;
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

const ROOT = "/attachments/remote-image-localization";

export const remoteImageLocalizationApi = {
  scan(scope: RemoteImageLocalizationScope): Promise<RemoteImageLocalizationScan> {
    return authenticatedJson(`${ROOT}/scan`, {
      method: "POST",
      body: JSON.stringify(scope),
    });
  },

  createJob(scope: RemoteImageLocalizationScope): Promise<RemoteImageLocalizationJob> {
    return authenticatedJson(`${ROOT}/jobs`, {
      method: "POST",
      body: JSON.stringify(scope),
    });
  },

  getJob(jobId: string): Promise<RemoteImageLocalizationJob> {
    return authenticatedJson(`${ROOT}/jobs/${encodeURIComponent(jobId)}`);
  },

  listJobs(limit = 20): Promise<{ jobs: RemoteImageLocalizationJob[] }> {
    return authenticatedJson(`${ROOT}/jobs?limit=${encodeURIComponent(String(limit))}`);
  },

  cancelJob(jobId: string): Promise<RemoteImageLocalizationJob> {
    return authenticatedJson(`${ROOT}/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      body: "{}",
    });
  },

  retryJob(jobId: string): Promise<RemoteImageLocalizationJob> {
    return authenticatedJson(`${ROOT}/jobs/${encodeURIComponent(jobId)}/retry`, {
      method: "POST",
      body: "{}",
    });
  },
};

export function isRemoteImageLocalizationJobActive(job: RemoteImageLocalizationJob | null | undefined): boolean {
  return job?.status === "queued" || job?.status === "running";
}
