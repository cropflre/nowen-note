import { getBaseUrl } from "@/lib/api";
import { normalizeSheetData, type SheetDataModel } from "@/lib/sheetModel";

export interface SheetDocument {
  noteId: string;
  title: string;
  workspaceId: string | null;
  data: SheetDataModel;
  updatedAt: string;
  canEdit: boolean;
}

async function request<T>(noteId: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("nowen-token") || "";
  const headers = new Headers(init?.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${getBaseUrl()}/sheets/${encodeURIComponent(noteId)}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || `请求失败 (${response.status})`) as Error & { code?: string; payload?: any };
    error.code = payload?.code;
    error.payload = payload;
    throw error;
  }
  return payload as T;
}

export async function getSheet(noteId: string): Promise<SheetDocument> {
  const result = await request<any>(noteId);
  return { ...result, data: normalizeSheetData(result.data) };
}

export async function saveSheet(noteId: string, data: SheetDataModel, expectedUpdatedAt: string): Promise<Pick<SheetDocument, "data" | "updatedAt" | "canEdit" | "noteId">> {
  const result = await request<any>(noteId, {
    method: "PUT",
    body: JSON.stringify({ data, expectedUpdatedAt }),
  });
  return { ...result, data: normalizeSheetData(result.data) };
}
