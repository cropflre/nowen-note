import { getBaseUrl } from "@/lib/api";

export interface ExcelDocument {
  noteId: string;
  title: string;
  workspaceId: string | null;
  data: Record<string, unknown>;
  updatedAt: string;
  canEdit: boolean;
}

async function request<T>(noteId: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("nowen-token") || "";
  const headers = new Headers(init?.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${getBaseUrl()}/excels/${encodeURIComponent(noteId)}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || `请求失败 (${response.status})`) as Error & { code?: string; payload?: unknown };
    error.code = payload?.code;
    error.payload = payload;
    throw error;
  }
  return payload as T;
}

export async function getExcelDocument(noteId: string): Promise<ExcelDocument> {
  return request<ExcelDocument>(noteId);
}

export async function saveExcelDocument(
  noteId: string,
  data: Record<string, unknown>,
  expectedUpdatedAt: string,
): Promise<Pick<ExcelDocument, "data" | "updatedAt" | "canEdit" | "noteId">> {
  return request<ExcelDocument>(noteId, {
    method: "PUT",
    body: JSON.stringify({ data, expectedUpdatedAt }),
  });
}
