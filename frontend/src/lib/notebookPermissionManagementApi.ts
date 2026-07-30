import { getBaseUrl } from "@/lib/api.impl";
import type { NotebookMember } from "@/types";

export interface NotebookPermissionSummary {
  notebookId: string;
  workspaceId: string | null;
  ownerId: string;
  members: NotebookMember[];
}

export interface NotebookOwnershipTransferResult {
  notebookId: string;
  previousOwnerId: string;
  newOwnerId: string;
  notebookCount: number;
  noteCount: number;
  attachmentCount: number;
  detachedFromParent: boolean;
}

class NotebookPermissionManagementApiError extends Error {
  code?: string;
  status?: number;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("nowen-token");
  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new NotebookPermissionManagementApiError(
      typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`,
    );
    error.code = payload?.code;
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

export const notebookPermissionManagementApi = {
  getSummary(notebookId: string): Promise<NotebookPermissionSummary> {
    return request(`/notebooks/${encodeURIComponent(notebookId)}/permission-summary`);
  },

  transferOwnership(
    notebookId: string,
    targetUserId: string,
  ): Promise<NotebookOwnershipTransferResult> {
    return request(`/notebooks/${encodeURIComponent(notebookId)}/transfer-owner`, {
      method: "POST",
      body: JSON.stringify({ targetUserId }),
    });
  },
};
