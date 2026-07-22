import { getServerUrl } from "@/lib/api";

export type NotebookPublicationAccessMode = "public" | "link" | "code" | "password";
export type NotebookPublicationPermission = "read" | "comment" | "write";
export type NotebookDirectoryPermission = "none" | "read" | "comment" | "write" | "manage";

export interface NotebookPublication {
  id: string;
  notebookId: string;
  ownerId: string;
  token: string;
  accessMode: NotebookPublicationAccessMode;
  permission: NotebookPublicationPermission;
  allowDownload: number | boolean;
  allowComment: number | boolean;
  allowEdit: number | boolean;
  allowReshare: number | boolean;
  expiresAt: string | null;
  isActive: number | boolean;
  createdAt: string;
  updatedAt: string;
  hasSecret?: boolean;
}

export interface PublicNotebookInfo {
  token: string;
  notebookId: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  ownerUsername: string;
  ownerDisplayName?: string | null;
  accessMode: NotebookPublicationAccessMode;
  permission: NotebookPublicationPermission;
  allowDownload: boolean;
  allowComment: boolean;
  allowEdit: boolean;
  allowReshare: boolean;
  expiresAt: string | null;
  needSecret: boolean;
  secretLabel: string | null;
}

export interface PublicNotebookIndexItem {
  token: string;
  notebookId: string;
  permission: NotebookPublicationPermission;
  allowDownload: number | boolean;
  allowComment: number | boolean;
  updatedAt: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  ownerUsername: string;
  ownerDisplayName?: string | null;
  noteCount: number;
}

export interface PublicNotebookNode {
  id: string;
  parentId: string | null;
  name: string;
  icon?: string | null;
  color?: string | null;
  sortOrder: number;
  depth: number;
}

export interface PublicNoteSummary {
  id: string;
  notebookId: string;
  title: string;
  contentText?: string | null;
  contentFormat?: string | null;
  updatedAt: string;
}

export interface PublicNoteContent extends PublicNoteSummary {
  content: string;
  version: number;
  attachmentUrls: Record<string, string>;
  permission: NotebookPublicationPermission;
  allowDownload: boolean;
  allowComment: boolean;
  allowEdit: boolean;
}

export interface NotebookPermissionOverride {
  notebookId: string;
  userId: string;
  permission: NotebookDirectoryPermission;
  allowDownload: number | boolean;
  allowReshare: number | boolean;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
  username: string;
  displayName?: string | null;
  email?: string | null;
}

export interface PublicComment {
  id: string;
  nickname: string;
  content: string;
  isResolved?: number | boolean;
  createdAt: string;
}

export interface ManagedPublicationComment extends PublicComment {
  noteId: string;
  noteTitle: string;
  isHidden: number | boolean;
}

function apiBase(): string {
  const server = (getServerUrl() || "").replace(/\/+$/, "");
  return server ? `${server}/api` : "/api";
}

function loginToken(): string {
  try {
    return localStorage.getItem("nowen-token") || "";
  } catch {
    return "";
  }
}

function normalizeContentFormat(value: string | null | undefined): string | null | undefined {
  if (value === "markdown") return "md";
  return value;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  options: { authenticated?: boolean; accessToken?: string } = {},
): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const bearer = options.authenticated ? loginToken() : options.accessToken || "";
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);

  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || `请求失败 (${response.status})`) as Error & {
      status?: number;
      code?: string;
      payload?: unknown;
    };
    error.status = response.status;
    error.code = payload?.code;
    error.payload = payload;
    throw error;
  }
  return payload as T;
}

export const notebookPublicationApi = {
  getPublication(notebookId: string) {
    return request<NotebookPublication | null>(`/notebooks/${encodeURIComponent(notebookId)}/publication`, {}, { authenticated: true });
  },

  savePublication(notebookId: string, input: {
    accessMode: NotebookPublicationAccessMode;
    permission: NotebookPublicationPermission;
    secret?: string;
    allowDownload?: boolean;
    allowComment?: boolean;
    allowEdit?: boolean;
    allowReshare?: boolean;
    expiresAt?: string | null;
  }) {
    return request<NotebookPublication>(
      `/notebooks/${encodeURIComponent(notebookId)}/publication`,
      { method: "PUT", body: JSON.stringify(input) },
      { authenticated: true },
    );
  },

  revokePublication(notebookId: string) {
    return request<{ success: boolean; revoked: boolean }>(
      `/notebooks/${encodeURIComponent(notebookId)}/publication`,
      { method: "DELETE" },
      { authenticated: true },
    );
  },

  getManagedComments(notebookId: string) {
    return request<ManagedPublicationComment[]>(
      `/notebooks/${encodeURIComponent(notebookId)}/publication/comments`,
      {},
      { authenticated: true },
    );
  },

  moderateComment(notebookId: string, commentId: string, input: { isResolved?: boolean; isHidden?: boolean }) {
    return request<{ success: true; id: string; isResolved: number; isHidden: number }>(
      `/notebooks/${encodeURIComponent(notebookId)}/publication/comments/${encodeURIComponent(commentId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
      { authenticated: true },
    );
  },

  deleteManagedComment(notebookId: string, commentId: string) {
    return request<{ success: true }>(
      `/notebooks/${encodeURIComponent(notebookId)}/publication/comments/${encodeURIComponent(commentId)}`,
      { method: "DELETE" },
      { authenticated: true },
    );
  },

  getPermissionOverrides(notebookId: string) {
    return request<{ direct: NotebookPermissionOverride[]; inheritsFromParent: string | null }>(
      `/notebooks/${encodeURIComponent(notebookId)}/permission-overrides`,
      {},
      { authenticated: true },
    );
  },

  setPermissionOverride(notebookId: string, userId: string, input: {
    permission: NotebookDirectoryPermission;
    allowDownload?: boolean;
    allowReshare?: boolean;
  }) {
    return request<{ success: true }>(
      `/notebooks/${encodeURIComponent(notebookId)}/permission-overrides/${encodeURIComponent(userId)}`,
      { method: "PUT", body: JSON.stringify(input) },
      { authenticated: true },
    );
  },

  removePermissionOverride(notebookId: string, userId: string) {
    return request<{ success: true }>(
      `/notebooks/${encodeURIComponent(notebookId)}/permission-overrides/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
      { authenticated: true },
    );
  },

  getPublicIndex() {
    return request<PublicNotebookIndexItem[]>("/shared/notebook-public/index");
  },

  getPublicInfo(token: string) {
    return request<PublicNotebookInfo>(`/shared/notebook-public/${encodeURIComponent(token)}`);
  },

  verifyPublicSecret(token: string, secret: string) {
    return request<{ success: true; accessToken: string }>(
      `/shared/notebook-public/${encodeURIComponent(token)}/verify`,
      { method: "POST", body: JSON.stringify({ secret }) },
    );
  },

  async getPublicTree(token: string, accessToken?: string) {
    const tree = await request<{ notebooks: PublicNotebookNode[]; notes: PublicNoteSummary[] }>(
      `/shared/notebook-public/${encodeURIComponent(token)}/tree`,
      {},
      { accessToken },
    );
    return {
      notebooks: tree.notebooks,
      notes: tree.notes.map((note) => ({ ...note, contentFormat: normalizeContentFormat(note.contentFormat) })),
    };
  },

  async getPublicNote(token: string, noteId: string, accessToken?: string) {
    const note = await request<PublicNoteContent>(
      `/shared/notebook-public/${encodeURIComponent(token)}/notes/${encodeURIComponent(noteId)}`,
      {},
      { accessToken },
    );
    return { ...note, contentFormat: normalizeContentFormat(note.contentFormat) };
  },

  getComments(token: string, noteId: string, accessToken?: string) {
    return request<PublicComment[]>(
      `/shared/notebook-public/${encodeURIComponent(token)}/notes/${encodeURIComponent(noteId)}/comments`,
      {},
      { accessToken },
    );
  },

  addComment(token: string, noteId: string, input: { nickname: string; content: string; _hp?: string }, accessToken?: string) {
    return request<PublicComment>(
      `/shared/notebook-public/${encodeURIComponent(token)}/notes/${encodeURIComponent(noteId)}/comments`,
      { method: "POST", body: JSON.stringify(input) },
      { accessToken },
    );
  },

  joinPublication(token: string, accessToken?: string) {
    return request<{ success: true; notebookId: string; role: string }>(
      `/shared/notebook-public/${encodeURIComponent(token)}/join`,
      { method: "POST", body: JSON.stringify({ accessToken: accessToken || "" }) },
      { authenticated: true },
    );
  },
};
