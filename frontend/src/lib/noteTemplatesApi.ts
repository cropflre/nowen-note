import { getCurrentWorkspace, getServerUrl } from "@/lib/api";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

export type NoteTemplateFormat = "tiptap-json" | "markdown";

export interface NoteTemplateSummary {
  id: string;
  workspaceId: string | null;
  createdBy: string;
  name: string;
  contentFormat: NoteTemplateFormat;
  sourceNoteId: string | null;
  attachmentCount: number;
  createdAt: string;
  updatedAt: string;
  canDelete: boolean;
}

function apiBase(): string {
  const server = (getServerUrl() || "").replace(/\/+$/, "");
  return server ? `${server}/api/note-templates` : "/api/note-templates";
}

function workspaceQuery(): string {
  return new URLSearchParams({ workspaceId: getCurrentWorkspace() }).toString();
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  const token = localStorage.getItem("nowen-token") || "";
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiBase()}${path}`, { ...init, headers, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || `请求失败 (${response.status})`) as Error & {
      status?: number;
      code?: string;
    };
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload as T;
}

export const noteTemplatesApi = {
  list() {
    return request<{ templates: NoteTemplateSummary[] }>(`?${workspaceQuery()}`);
  },

  createFromNote(noteId: string, name: string) {
    return request<{ template: NoteTemplateSummary }>(
      `/from-note/${encodeURIComponent(noteId)}?${workspaceQuery()}`,
      { method: "POST", body: JSON.stringify({ name }) },
    );
  },

  remove(templateId: string) {
    return request<{ success: true }>(
      `/${encodeURIComponent(templateId)}?${workspaceQuery()}`,
      { method: "DELETE" },
    );
  },

  createNote(templateId: string, parentId: string | null) {
    return request<{ noteId: string; node: KnowledgeTreeNode }>(
      `/${encodeURIComponent(templateId)}/create-note?${workspaceQuery()}`,
      { method: "POST", body: JSON.stringify({ parentId }) },
    );
  },
};
