import { Notebook, Note, NoteListItem, Tag, SearchResult, User, Task, TaskStats, TaskFilter, CustomFont, MindMap, MindMapListItem, DocumentItem, DocumentListItem, DocType } from "@/types";

const BASE_URL = "/api";

function getToken(): string | null {
  return localStorage.getItem("nowen-token");
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE_URL}${url}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  if (res.status === 401) {
    // Token 过期或无效，清除并跳转登录
    localStorage.removeItem("nowen-token");
    window.location.reload();
    throw new Error("未授权");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Public (no auth required)
  getSiteSettingsPublic: async (): Promise<{ site_title: string; site_favicon: string; editor_font_family: string }> => {
    const res = await fetch(`${BASE_URL}/settings`);
    if (!res.ok) return { site_title: "nowen-note", site_favicon: "", editor_font_family: "" };
    return res.json();
  },

  // User
  getMe: () => request<User>("/me"),

  // Notebooks
  getNotebooks: () => request<Notebook[]>("/notebooks"),
  createNotebook: (data: Partial<Notebook>) => request<Notebook>("/notebooks", { method: "POST", body: JSON.stringify(data) }),
  updateNotebook: (id: string, data: Partial<Notebook>) => request<Notebook>(`/notebooks/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteNotebook: (id: string) => request(`/notebooks/${id}`, { method: "DELETE" }),

  // Notes
  getNotes: (params?: Record<string, string>) => {
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return request<NoteListItem[]>(`/notes${qs}`);
  },
  getNote: (id: string) => request<Note>(`/notes/${id}`),
  createNote: (data: Partial<Note>) => request<Note>("/notes", { method: "POST", body: JSON.stringify(data) }),
  updateNote: (id: string, data: Partial<Note>) => request<Note>(`/notes/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteNote: (id: string) => request(`/notes/${id}`, { method: "DELETE" }),

  // Tags
  getTags: () => request<Tag[]>("/tags"),
  createTag: (data: Partial<Tag>) => request<Tag>("/tags", { method: "POST", body: JSON.stringify(data) }),
  deleteTag: (id: string) => request(`/tags/${id}`, { method: "DELETE" }),
  addTagToNote: (noteId: string, tagId: string) => request(`/tags/note/${noteId}/tag/${tagId}`, { method: "POST" }),
  removeTagFromNote: (noteId: string, tagId: string) => request(`/tags/note/${noteId}/tag/${tagId}`, { method: "DELETE" }),
  getNotesWithTag: (tagId: string) => request<NoteListItem[]>(`/notes?tagId=${encodeURIComponent(tagId)}`),

  // Search
  search: (q: string) => request<SearchResult[]>(`/search?q=${encodeURIComponent(q)}`),

  // Tasks
  getTasks: (filter?: TaskFilter, noteId?: string) => {
    const params = new URLSearchParams();
    if (filter && filter !== "all") params.set("filter", filter);
    if (noteId) params.set("noteId", noteId);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return request<Task[]>(`/tasks${qs}`);
  },
  getTask: (id: string) => request<Task>(`/tasks/${id}`),
  createTask: (data: Partial<Task>) => request<Task>("/tasks", { method: "POST", body: JSON.stringify(data) }),
  updateTask: (id: string, data: Partial<Task>) => request<Task>(`/tasks/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  toggleTask: (id: string) => request<Task>(`/tasks/${id}/toggle`, { method: "PATCH" }),
  deleteTask: (id: string) => request(`/tasks/${id}`, { method: "DELETE" }),
  getTaskStats: () => request<TaskStats>("/tasks/stats/summary"),

  // Security
  updateSecurity: (data: { currentPassword: string; newUsername?: string; newPassword?: string }) =>
    request<{ success: boolean; message: string }>("/auth/change-password", { method: "POST", body: JSON.stringify(data) }),
  factoryReset: (confirmText: string) =>
    request<{ success: boolean; message: string }>("/auth/factory-reset", { method: "POST", body: JSON.stringify({ confirmText }) }),

  // Export / Import
  getExportNotes: () => request<any[]>("/export/notes"),
  importNotes: (notes: { title: string; content: string; contentText: string; createdAt?: string; updatedAt?: string }[], notebookId?: string) =>
    request<{ success: boolean; count: number; notebookId: string; notes: any[] }>("/export/import", {
      method: "POST",
      body: JSON.stringify({ notes, notebookId }),
    }),

  // Site Settings
  getSiteSettings: () => request<{ site_title: string; site_favicon: string; editor_font_family: string }>("/settings"),
  updateSiteSettings: (data: { site_title?: string; site_favicon?: string; editor_font_family?: string }) =>
    request<{ site_title: string; site_favicon: string; editor_font_family: string }>("/settings", {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  // Fonts
  getFonts: () => request<CustomFont[]>("/fonts"),
  getFontsPublic: async (): Promise<CustomFont[]> => {
    const res = await fetch(`${BASE_URL}/fonts`);
    if (!res.ok) return [];
    return res.json();
  },
  uploadFonts: async (files: FileList | File[]): Promise<{ uploaded: CustomFont[]; errors: string[] }> => {
    const token = getToken();
    const form = new FormData();
    for (const file of Array.from(files)) {
      form.append("files", file);
    }
    const res = await fetch(`${BASE_URL}/fonts/upload`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "上传失败");
    }
    return res.json();
  },
  deleteFont: (id: string) => request(`/fonts/${id}`, { method: "DELETE" }),
  getFontFileUrl: (id: string) => `${BASE_URL}/fonts/file/${id}`,

  // Mi Cloud
  miCloudVerify: (cookie: string) =>
    request<{ valid: boolean; error?: string }>("/micloud/verify", {
      method: "POST",
      body: JSON.stringify({ cookie }),
    }),
  miCloudNotes: (cookie: string) =>
    request<{ notes: any[]; folders: Record<string, string> }>("/micloud/notes", {
      method: "POST",
      body: JSON.stringify({ cookie }),
    }),
  miCloudImport: (cookie: string, noteIds: string[], notebookId?: string) =>
    request<{ success: boolean; count: number; errors: string[] }>("/micloud/import", {
      method: "POST",
      body: JSON.stringify({ cookie, noteIds, notebookId }),
    }),

  // OPPO Cloud
  oppoCloudImport: (notes: { id: string; title: string; content: string }[], notebookId?: string) =>
    request<{ success: boolean; count: number; notebookId: string; notes: any[]; errors: string[] }>("/oppocloud/import", {
      method: "POST",
      body: JSON.stringify({ notes, notebookId }),
    }),

  // Mind Maps
  getMindMaps: () => request<MindMapListItem[]>("/mindmaps"),
  getMindMap: (id: string) => request<MindMap>(`/mindmaps/${id}`),
  createMindMap: (data: { title?: string; data?: string }) =>
    request<MindMap>("/mindmaps", { method: "POST", body: JSON.stringify(data) }),
  updateMindMap: (id: string, data: { title?: string; data?: string }) =>
    request<MindMap>(`/mindmaps/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteMindMap: (id: string) => request(`/mindmaps/${id}`, { method: "DELETE" }),

  // Documents
  getDocuments: (docType?: string) => {
    const params = docType && docType !== "all" ? `?docType=${docType}` : "";
    return request<DocumentListItem[]>(`/documents${params}`);
  },
  getDocument: (id: string) => request<DocumentItem>(`/documents/${id}`),
  createDocument: (data: { title?: string; docType?: DocType }) =>
    request<DocumentItem>("/documents", { method: "POST", body: JSON.stringify(data) }),
  uploadDocument: async (file: File): Promise<DocumentItem> => {
    const token = getToken();
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${BASE_URL}/documents/upload`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "上传失败");
    }
    return res.json();
  },
  updateDocument: (id: string, data: { title?: string }) =>
    request<DocumentItem>(`/documents/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteDocument: (id: string) => request(`/documents/${id}`, { method: "DELETE" }),
  batchDeleteDocuments: (ids: string[]) =>
    request<{ success: boolean; count: number }>("/documents/batch-delete", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
  getDocumentEditorConfig: (id: string) =>
    request<{ editorConfig: any; onlyofficeUrl: string }>(`/documents/${id}/editor-config`),
  getOnlyOfficeStatus: () =>
    request<{ available: boolean; url: string }>("/documents/onlyoffice/status"),

  // AI
  getAISettings: () =>
    request<{ ai_provider: string; ai_api_url: string; ai_api_key: string; ai_api_key_set: boolean; ai_model: string }>("/ai/settings"),
  updateAISettings: (data: { ai_provider?: string; ai_api_url?: string; ai_api_key?: string; ai_model?: string }) =>
    request<{ ai_provider: string; ai_api_url: string; ai_api_key: string; ai_api_key_set: boolean; ai_model: string }>("/ai/settings", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  testAIConnection: () =>
    request<{ success: boolean; message?: string; error?: string }>("/ai/test", { method: "POST" }),
  getAIModels: () =>
    request<{ models: { id: string; name: string }[] }>("/ai/models"),
  aiChat: async (action: string, text: string, context?: string, onChunk?: (chunk: string) => void): Promise<string> => {
    const token = getToken();
    const res = await fetch(`${BASE_URL}/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ action, text, context }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `AI 请求失败: ${res.status}`);
    }
    // SSE stream
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let result = "";
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") break;
        result += data;
        onChunk?.(data);
      }
    }
    return result;
  },

  aiAsk: async (
    question: string,
    history?: { role: string; content: string }[],
    onChunk?: (chunk: string) => void,
    onReferences?: (refs: { id: string; title: string }[]) => void
  ): Promise<string> => {
    const token = getToken();
    const res = await fetch(`${BASE_URL}/ai/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ question, history }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `AI 请求失败: ${res.status}`);
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let result = "";
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("event:")) {
          const event = trimmed.slice(6).trim();
          // Read next data line
          continue;
        }
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") break;
        // Check if this is a references event by trying to parse as JSON array
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed) && parsed[0]?.id && parsed[0]?.title) {
            onReferences?.(parsed);
            continue;
          }
        } catch { /* not JSON, treat as content chunk */ }
        result += data;
        onChunk?.(data);
      }
    }
    return result;
  },
};
