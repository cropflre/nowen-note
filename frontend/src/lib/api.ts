import { Notebook, Note, NoteListItem, Tag, SearchResult, User, Task, TaskStats, TaskFilter, CustomFont, MindMap, MindMapListItem, Diary, DiaryTimeline, DiaryStats, Share, ShareInfo, SharedNoteContent, NoteVersion, ShareComment } from "@/types";

// 服务器地址管理
const SERVER_URL_KEY = "nowen-server-url";
const DESKTOP_REMOTE_MODE_KEY = "nowen-desktop-remote-mode";
const DESKTOP_MODE_SELECTED_KEY = "nowen-desktop-mode-selected";

export function isElectronRuntime(): boolean {
  return typeof navigator !== "undefined" && /Electron/i.test(navigator.userAgent);
}

export function isDesktopRemoteModeEnabled(): boolean {
  return localStorage.getItem(DESKTOP_REMOTE_MODE_KEY) === "true";
}

export function setDesktopRemoteMode(enabled: boolean) {
  localStorage.setItem(DESKTOP_REMOTE_MODE_KEY, enabled ? "true" : "false");
}

export function hasDesktopModeSelection(): boolean {
  return localStorage.getItem(DESKTOP_MODE_SELECTED_KEY) === "true";
}

export function setDesktopModeSelection(selected: boolean) {
  localStorage.setItem(DESKTOP_MODE_SELECTED_KEY, selected ? "true" : "false");
}

export function getServerUrl(): string {
  return localStorage.getItem(SERVER_URL_KEY) || "";
}

export function setServerUrl(url: string) {
  const normalized = url.replace(/\/+$/, "");
  localStorage.setItem(SERVER_URL_KEY, normalized);
}

export function clearServerUrl() {
  localStorage.removeItem(SERVER_URL_KEY);
}

function getBaseUrl(): string {
  const server = getServerUrl();
  return server ? `${server}/api` : "/api";
}

function getToken(): string | null {
  return localStorage.getItem("nowen-token");
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${getBaseUrl()}${url}`, {
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
    const res = await fetch(`${getBaseUrl()}/settings`);
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
  updateTag: (id: string, data: Partial<Tag>) => request<Tag>(`/tags/${id}`, { method: "PUT", body: JSON.stringify(data) }),
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
    const res = await fetch(`${getBaseUrl()}/fonts`);
    if (!res.ok) return [];
    return res.json();
  },
  uploadFonts: async (files: FileList | File[]): Promise<{ uploaded: CustomFont[]; errors: string[] }> => {
    const token = getToken();
    const form = new FormData();
    for (const file of Array.from(files)) {
      form.append("files", file);
    }
    const res = await fetch(`${getBaseUrl()}/fonts/upload`, {
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
  getFontFileUrl: (id: string) => `${getBaseUrl()}/fonts/file/${id}`,

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

  // iCloud (iPhone 备忘录)
  icloudImport: (notes: { id: string; title: string; content: string; folder?: string; date?: string; createDate?: string; modifyDate?: string }[], notebookId?: string) =>
    request<{ success: boolean; count: number; notebookId: string; notes: any[]; errors: string[] }>("/icloud/import", {
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

  // Diary (说说/动态)
  postDiary: (data: { contentText: string; mood?: string }) =>
    request<Diary>("/diary", { method: "POST", body: JSON.stringify(data) }),
  getDiaryTimeline: (cursor?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    return request<DiaryTimeline>(`/diary/timeline${qs ? `?${qs}` : ""}`);
  },
  deleteDiary: (id: string) => request(`/diary/${id}`, { method: "DELETE" }),
  getDiaryStats: () => request<DiaryStats>("/diary/stats"),

  // Shares (分享管理)
  createShare: (data: { noteId: string; permission?: string; password?: string; expiresAt?: string; maxViews?: number }) =>
    request<Share>("/shares", { method: "POST", body: JSON.stringify(data) }),
  getShares: () => request<Share[]>("/shares"),
  getSharesByNote: (noteId: string) => request<Share[]>(`/shares/note/${noteId}`),
  getShare: (id: string) => request<Share>(`/shares/${id}`),
  updateShare: (id: string, data: Partial<{ permission: string; password: string; expiresAt: string; maxViews: number; isActive: number }>) =>
    request<Share>(`/shares/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteShare: (id: string) => request(`/shares/${id}`, { method: "DELETE" }),

  // 分享状态批量查询
  getSharedNoteIds: () => request<string[]>("/shares/status/batch"),

  // 版本历史
  getNoteVersions: (noteId: string, limit = 20, offset = 0) =>
    request<{ versions: NoteVersion[]; total: number }>(`/shares/note/${noteId}/versions?limit=${limit}&offset=${offset}`),
  getNoteVersion: (noteId: string, versionId: string) =>
    request<NoteVersion>(`/shares/note/${noteId}/versions/${versionId}`),
  restoreNoteVersion: (noteId: string, versionId: string) =>
    request<Note>(`/shares/note/${noteId}/versions/${versionId}/restore`, { method: "POST" }),

  // 评论批注
  getNoteComments: (noteId: string) => request<ShareComment[]>(`/shares/note/${noteId}/comments`),
  addNoteComment: (noteId: string, data: { content: string; parentId?: string; anchorData?: string }) =>
    request<ShareComment>(`/shares/note/${noteId}/comments`, { method: "POST", body: JSON.stringify(data) }),
  deleteNoteComment: (noteId: string, commentId: string) =>
    request(`/shares/note/${noteId}/comments/${commentId}`, { method: "DELETE" }),
  toggleCommentResolved: (noteId: string, commentId: string) =>
    request<ShareComment>(`/shares/note/${noteId}/comments/${commentId}/resolve`, { method: "PATCH" }),

  // Shared (公开访问，无需 JWT)
  getShareInfo: async (token: string): Promise<ShareInfo> => {
    const res = await fetch(`${getBaseUrl()}/shared/${token}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `请求失败: ${res.status}`);
    }
    return res.json();
  },
  verifySharePassword: async (token: string, password: string): Promise<{ success: boolean; accessToken: string }> => {
    const res = await fetch(`${getBaseUrl()}/shared/${token}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `请求失败: ${res.status}`);
    }
    return res.json();
  },
  getSharedContent: async (token: string, accessToken?: string): Promise<SharedNoteContent> => {
    const headers: Record<string, string> = {};
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    const res = await fetch(`${getBaseUrl()}/shared/${token}/content`, { headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `请求失败: ${res.status}`);
    }
    return res.json();
  },

  // Phase 4: 同步轮询
  pollSharedNote: async (token: string, accessToken?: string): Promise<{ version: number; updatedAt: string }> => {
    const headers: Record<string, string> = {};
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    const res = await fetch(`${getBaseUrl()}/shared/${token}/poll`, { headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `请求失败: ${res.status}`);
    }
    return res.json();
  },

  // 公开评论
  getSharedComments: async (token: string, accessToken?: string): Promise<ShareComment[]> => {
    const headers: Record<string, string> = {};
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    const res = await fetch(`${getBaseUrl()}/shared/${token}/comments`, { headers });
    if (!res.ok) return [];
    return res.json();
  },
  addSharedComment: async (token: string, data: { content: string; parentId?: string; guestName?: string }, accessToken?: string): Promise<ShareComment> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    const res = await fetch(`${getBaseUrl()}/shared/${token}/comments`, {
      method: "POST", headers, body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `请求失败: ${res.status}`);
    }
    return res.json();
  },

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
  aiChat: async (action: string, text: string, context?: string, onChunk?: (chunk: string) => void, customPrompt?: string): Promise<string> => {
    const token = getToken();
    const res = await fetch(`${getBaseUrl()}/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ action, text, context, ...(customPrompt ? { customPrompt } : {}) }),
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
    const res = await fetch(`${getBaseUrl()}/ai/ask`, {
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

  getKnowledgeStats: async (): Promise<{
    noteCount: number;
    ftsCount: number;
    notebookCount: number;
    tagCount: number;
    recentTopics: string[];
    indexed: boolean;
  }> => {
    const token = getToken();
    const res = await fetch(`${getBaseUrl()}/ai/knowledge-stats`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) throw new Error("获取知识库统计失败");
    return res.json();
  },

  // ③ 文档智能解析
  parseDocument: async (
    file: File,
    options?: { notebookId?: string; formatMode?: "markdown" | "note" }
  ): Promise<{
    success: boolean;
    markdown: string;
    fileName?: string;
    noteId?: string;
    saved?: boolean;
    error?: string;
  }> => {
    const token = getToken();
    const form = new FormData();
    form.append("file", file);
    if (options?.notebookId) form.append("notebookId", options.notebookId);
    if (options?.formatMode) form.append("formatMode", options.formatMode);
    const res = await fetch(`${getBaseUrl()}/ai/parse-document`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `解析失败: ${res.status}`);
    }
    return res.json();
  },

  // ⑤ 批量 Markdown 格式化
  batchFormatNotes: async (noteIds: string[]): Promise<{
    total: number;
    success: number;
    failed: number;
    results: { id: string; title: string; success: boolean; error?: string }[];
  }> => {
    return request("/ai/batch-format", {
      method: "POST",
      body: JSON.stringify({ noteIds }),
    });
  },

  // ⑥ 知识库文档导入
  importToKnowledge: async (
    files: File[],
    notebookId?: string
  ): Promise<{
    total: number;
    success: number;
    failed: number;
    notebookId: string;
    results: { fileName: string; success: boolean; noteId?: string; error?: string }[];
  }> => {
    const token = getToken();
    const form = new FormData();
    for (const file of files) {
      form.append("files", file);
    }
    if (notebookId) form.append("notebookId", notebookId);
    const res = await fetch(`${getBaseUrl()}/ai/import-to-knowledge`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `导入失败: ${res.status}`);
    }
    return res.json();
  },

  // Pipelines (批处理管道)
  getPipelines: () => request<any[]>("/pipelines"),
  createPipeline: (data: { name: string; description?: string; icon?: string; steps: any[] }) =>
    request<any>("/pipelines", { method: "POST", body: JSON.stringify(data) }),
  updatePipeline: (id: string, data: { name?: string; description?: string; icon?: string; steps?: any[] }) =>
    request<any>(`/pipelines/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deletePipeline: (id: string) => request(`/pipelines/${id}`, { method: "DELETE" }),
  runPipeline: (id: string, noteIds: string[]) =>
    request<{
      runId: string;
      pipelineId: string;
      pipelineName: string;
      total: number;
      success: number;
      failed: number;
      results: { noteId: string; title: string; success: boolean; steps: { type: string; success: boolean; error?: string }[] }[];
    }>(`/pipelines/${id}/run`, { method: "POST", body: JSON.stringify({ noteIds }) }),
  getPipelineRuns: () => request<any[]>("/pipelines/runs"),
  getPipelineStepTypes: () => request<{ type: string; name: string; icon: string; description: string }[]>("/pipelines/step-types"),

};

// 测试服务器连接（不需要 token）
export async function testServerConnection(serverUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = `${serverUrl.replace(/\/+$/, "")}/api/health`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    if (data.status === "ok") return { ok: true };
    return { ok: false, error: "Invalid response" };
  } catch (e: any) {
    if (e.name === "AbortError") return { ok: false, error: "连接超时" };
    return { ok: false, error: e.message || "连接失败" };
  }
}
