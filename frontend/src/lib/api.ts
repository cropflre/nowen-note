import { Notebook, Note, NoteListItem, Tag, SearchResult, User, Task, TaskStats, TaskFilter } from "@/types";

const BASE_URL = "/api";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${url}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": "demo",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
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

  // Export / Import
  getExportNotes: () => request<any[]>("/export/notes"),
  importNotes: (notes: { title: string; content: string; contentText: string }[], notebookId?: string) =>
    request<{ success: boolean; count: number; notebookId: string; notes: any[] }>("/export/import", {
      method: "POST",
      body: JSON.stringify({ notes, notebookId }),
    }),
};
