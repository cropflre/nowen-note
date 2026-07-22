import { getBaseUrl } from "@/lib/api.impl";

export type NoteTransferMode = "copy" | "move";

export type TransferSpace = {
  id: string;
  name: string;
  icon?: string | null;
  role?: string;
};

export type TransferNotebook = {
  id: string;
  name: string;
  parentId?: string | null;
  workspaceId?: string | null;
  icon?: string | null;
};

export type TransferNote = {
  id: string;
  title: string;
  notebookId: string;
  workspaceId?: string | null;
  isLocked?: number;
  isTrashed?: number;
  version?: number;
  updatedAt?: string;
};

export type NoteTransferPayload = {
  sourceNoteIds: string[];
  targetWorkspaceId: string | null;
  targetNotebookId: string;
  mode: NoteTransferMode;
  includeAttachments: boolean;
  includeTags: boolean;
  expectedVersions?: Record<string, number>;
};

export type NoteTransferPreview = {
  canExecute: boolean;
  mode: NoteTransferMode;
  sourceWorkspaceId: string | null;
  targetWorkspaceId: string | null;
  targetNotebookId: string;
  noteCount: number;
  attachmentCount: number;
  attachmentBytes: number;
  missingAttachmentCount: number;
  tagCount: number;
  internalNoteLinkCount: number;
  externalNoteLinkCount: number;
  sourceVersions: Record<string, number>;
  blockers: Array<{ code: string; message: string; noteId?: string }>;
  warnings: string[];
  omitted: string[];
  notes: Array<{
    id: string;
    title: string;
    version: number;
    isLocked: boolean;
    attachmentCount: number;
  }>;
};

export type NoteTransferResult = {
  mode: NoteTransferMode;
  sourceWorkspaceId: string | null;
  targetWorkspaceId: string | null;
  targetNotebookId: string;
  copiedNoteCount: number;
  copiedAttachmentCount: number;
  copiedTagCount: number;
  skippedAttachmentCount: number;
  movedSourceNoteCount: number;
  internalNoteLinkCount: number;
  externalNoteLinkCount: number;
  warnings: string[];
  omitted: string[];
  items: Array<{ sourceNoteId: string; targetNoteId: string; title: string }>;
};

export class NoteTransferApiError extends Error {
  code?: string;
  status?: number;
  details?: unknown;
}

function workspaceQuery(workspaceId: string | null): string {
  return workspaceId ? workspaceId : "personal";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("nowen-token");
  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  let data: any = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const error = new NoteTransferApiError(
      typeof data?.error === "string" ? data.error : `HTTP ${response.status}`,
    );
    error.code = data?.code;
    error.status = response.status;
    error.details = data?.details;
    throw error;
  }
  return data as T;
}

export const noteTransferApi = {
  async listSpaces(): Promise<TransferSpace[]> {
    const workspaces = await request<TransferSpace[]>("/workspaces");
    return [
      { id: "personal", name: "个人空间", icon: "👤", role: "owner" },
      ...workspaces,
    ];
  },

  listNotebooks(workspaceId: string | null): Promise<TransferNotebook[]> {
    const query = new URLSearchParams({ workspaceId: workspaceQuery(workspaceId) });
    return request<TransferNotebook[]>(`/notebooks?${query.toString()}`);
  },

  listNotes(workspaceId: string | null): Promise<TransferNote[]> {
    const query = new URLSearchParams({ workspaceId: workspaceQuery(workspaceId) });
    return request<TransferNote[]>(`/notes?${query.toString()}`);
  },

  preview(payload: NoteTransferPayload): Promise<NoteTransferPreview> {
    return request<NoteTransferPreview>("/note-transfers/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  execute(payload: NoteTransferPayload): Promise<NoteTransferResult> {
    return request<NoteTransferResult>("/note-transfers", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
};
