import { getBaseUrl } from "@/lib/api";
import type {
  FolderSyncConflictPolicy,
  FolderSyncDeletionPolicy,
} from "@/lib/folderSyncPreferences";

export interface FolderSyncImportResult {
  success: boolean;
  created: boolean;
  updated: boolean;
  skipped: boolean;
  noteId: string;
  attachmentId?: string;
  sha256: string;
  reason?: string;
  detached?: boolean;
  conflictCopyNoteId?: string;
  extracted?: boolean;
  extractedChars?: number;
  extractionTruncated?: boolean;
  extractionError?: string;
  noText?: boolean;
}

export interface FolderSyncDeletedResult {
  success: true;
  action: FolderSyncDeletionPolicy;
  noteId: string | null;
  mappingRemoved: boolean;
}

type ApiError = Error & { code?: string; status?: number; detail?: unknown };

function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  try {
    const token = localStorage.getItem("nowen-token");
    if (token) headers.set("Authorization", `Bearer ${token}`);
  } catch {
    // request will receive the normal 401 response
  }
  return headers;
}

async function readJsonResponse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body?.error || `HTTP ${res.status}`) as ApiError;
    error.code = typeof body?.code === "string" ? body.code : undefined;
    error.status = res.status;
    error.detail = body;
    throw error;
  }
  return body as T;
}

export async function importFolderSyncText(payload: {
  filename: string;
  relativePath: string;
  sha256: string;
  targetNotebookId: string;
  contentText: string;
  sourcePathHash: string;
  existingNoteId?: string;
  conflictPolicy: FolderSyncConflictPolicy;
  preserveHierarchy?: boolean;
  sourceFolderId?: string;
}): Promise<FolderSyncImportResult> {
  const res = await fetch(`${getBaseUrl()}/folder-sync/import-file`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  return readJsonResponse<FolderSyncImportResult>(res);
}

export async function importFolderSyncAttachment(payload: {
  filename: string;
  relativePath: string;
  sha256: string;
  targetNotebookId: string;
  sourcePathHash: string;
  existingNoteId?: string;
  conflictPolicy: FolderSyncConflictPolicy;
  extractText: boolean;
  preserveHierarchy?: boolean;
  sourceFolderId?: string;
  file: File | Blob;
}): Promise<FolderSyncImportResult> {
  const form = new FormData();
  form.append("file", payload.file, payload.filename);
  form.append("sourcePathHash", payload.sourcePathHash);
  form.append("relativePath", payload.relativePath);
  form.append("filename", payload.filename);
  form.append("sha256", payload.sha256);
  form.append("targetNotebookId", payload.targetNotebookId);
  form.append("conflictPolicy", payload.conflictPolicy);
  form.append("extractText", payload.extractText ? "1" : "0");
  if (payload.preserveHierarchy) {
    form.append("preserveHierarchy", "1");
    form.append("sourceFolderId", payload.sourceFolderId || "");
  }
  if (payload.existingNoteId) form.append("existingNoteId", payload.existingNoteId);

  const res = await fetch(`${getBaseUrl()}/folder-sync/import-attachment`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(),
    body: form,
  });
  return readJsonResponse<FolderSyncImportResult>(res);
}

export async function organizeExistingFolderSyncNote(payload: {
  relativePath: string;
  targetNotebookId: string;
  sourcePathHash: string;
  sourceFolderId: string;
}): Promise<{ success: boolean; noteId: string; notebookId: string; moved: boolean }> {
  const res = await fetch(`${getBaseUrl()}/folder-sync/organize-file`, {
    method: "POST", credentials: "include",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  return readJsonResponse(res);
}

export async function handleFolderSyncSourceDeleted(payload: {
  sourcePathHash: string;
  policy: FolderSyncDeletionPolicy;
}): Promise<FolderSyncDeletedResult> {
  const res = await fetch(`${getBaseUrl()}/folder-sync/source-deleted`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  return readJsonResponse<FolderSyncDeletedResult>(res);
}

export function getFolderSyncErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as ApiError).code;
  return typeof code === "string" ? code : undefined;
}
