import { getBaseUrl, getCurrentWorkspace } from "@/lib/api";
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

export interface NoteTemplateContext {
  parentId?: string | null;
  workspaceId?: string | null;
}

function workspaceQuery(context: NoteTemplateContext = {}): string {
  const params = new URLSearchParams();
  // A shared folder can belong to a different workspace from the current view.
  // Without an explicit scope, the server resolves it from the authorized target.
  if (context.workspaceId !== undefined || !context.parentId) {
    params.set("workspaceId", context.workspaceId === undefined ? getCurrentWorkspace() : context.workspaceId || "personal");
  }
  if (context.parentId) params.set("parentId", context.parentId);
  return params.toString();
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  const baseUrl = getBaseUrl();
  const currentWorkspace = getCurrentWorkspace();
  const token = localStorage.getItem("nowen-token") || "";
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}/note-templates${path}`, { ...init, headers, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (baseUrl !== getBaseUrl() || currentWorkspace !== getCurrentWorkspace() || token !== (localStorage.getItem("nowen-token") || "")) {
    throw new Error("账号、服务器或空间已切换，请重新打开模板");
  }
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
  list(context: NoteTemplateContext = {}) {
    return request<{ templates: NoteTemplateSummary[] }>(`?${workspaceQuery(context)}`);
  },

  createFromNote(noteId: string, name: string) {
    return request<{ template: NoteTemplateSummary }>(
      `/from-note/${encodeURIComponent(noteId)}?${workspaceQuery()}`,
      { method: "POST", body: JSON.stringify({ name }) },
    );
  },

  remove(templateId: string, workspaceId?: string | null) {
    return request<{ success: true }>(
      `/${encodeURIComponent(templateId)}?${workspaceQuery({ workspaceId })}`,
      { method: "DELETE" },
    );
  },

  createNote(templateId: string, parentId: string | null, workspaceId?: string | null) {
    return request<{ noteId: string; node: KnowledgeTreeNode }>(
      `/${encodeURIComponent(templateId)}/create-note?${workspaceQuery({ parentId, workspaceId })}`,
      { method: "POST", body: JSON.stringify({ parentId }) },
    );
  },
};
