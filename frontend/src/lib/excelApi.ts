// Excel 工作簿 API。功能来源：cropflre/nowen-note PR #802；改为复用现有的令牌刷新请求链路。
import { getBaseUrl } from "@/lib/api";
import { fetchWithAuthRefresh, getAccessToken } from "@/lib/authSession";
import type { ExcelSaveError, ExcelSnapshot } from "@/lib/excelSaveController";

export interface ExcelDocument {
  noteId: string;
  title: string;
  workspaceId: string | null;
  data: ExcelSnapshot;
  revision: number;
  updatedAt: string;
  canEdit: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {});
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  const baseUrl = getBaseUrl();
  const response = await fetchWithAuthRefresh(`${baseUrl}/excels${path}`, { ...init, headers, cache: "no-store" }, baseUrl);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || `请求失败 (${response.status})`) as ExcelSaveError;
    error.code = payload?.code;
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload as T;
}

export function getExcelDocument(noteId: string): Promise<ExcelDocument> {
  return request<ExcelDocument>(`/${encodeURIComponent(noteId)}`);
}

export function saveExcelDocument(noteId: string, data: ExcelSnapshot, expectedRevision: number): Promise<{ revision: number; updatedAt: string }> {
  return request(`/${encodeURIComponent(noteId)}`, {
    method: "PUT",
    body: JSON.stringify({ data, expectedRevision }),
  });
}

let capabilities: Promise<boolean> | null = null;

/** 服务器是否开放新建 Excel 表格（1.6.2 默认关闭）。旧服务器没有该接口时视为关闭。 */
export function isExcelCreationEnabled(): Promise<boolean> {
  if (!capabilities) {
    capabilities = request<{ createEnabled?: boolean }>("/capabilities")
      .then((result) => result.createEnabled === true)
      .catch(() => {
        capabilities = null;
        return false;
      });
  }
  return capabilities;
}
