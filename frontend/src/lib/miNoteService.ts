import { api } from "./api";

export interface MiNoteEntry {
  id: string;
  title: string;
  snippet: string;
  folderId: string;
  folderName: string;
  createDate: number;
  modifyDate: number;
  colorId: number;
  selected: boolean;
}

export interface MiCloudState {
  phase: "idle" | "verifying" | "loading" | "ready" | "importing" | "done" | "error";
  message: string;
  notes: MiNoteEntry[];
  folders: Record<string, string>;
  importedCount: number;
}

const MI_CLOUD_COOKIE_KEY = "mi-cloud-cookie";

// 保存 cookie 到 sessionStorage（不持久化到 localStorage，安全考虑）
export function saveMiCookie(cookie: string) {
  sessionStorage.setItem(MI_CLOUD_COOKIE_KEY, cookie);
}

export function getMiCookie(): string {
  return sessionStorage.getItem(MI_CLOUD_COOKIE_KEY) || "";
}

export function clearMiCookie() {
  sessionStorage.removeItem(MI_CLOUD_COOKIE_KEY);
}

// 验证 Cookie
export async function verifyMiCookie(cookie: string): Promise<{ valid: boolean; error?: string }> {
  const res = await api.miCloudVerify(cookie);
  return res;
}

// 获取笔记列表
export async function fetchMiNotes(cookie: string): Promise<{
  notes: MiNoteEntry[];
  folders: Record<string, string>;
}> {
  const res = await api.miCloudNotes(cookie);
  return {
    notes: res.notes.map((n: any) => ({ ...n, selected: true })),
    folders: res.folders,
  };
}

// 导入选中的笔记
export async function importMiNotes(
  cookie: string,
  noteIds: string[],
  notebookId?: string
): Promise<{ success: boolean; count: number; errors: string[] }> {
  return api.miCloudImport(cookie, noteIds, notebookId);
}
