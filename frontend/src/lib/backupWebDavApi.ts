import { getBaseUrl } from "./api";
import { fetchWithAuthRefresh, getAccessToken } from "./authSession";

export interface RemoteBackup {
  filename: string;
  size: number;
  createdAt: string;
  type: "full" | "db-only";
}

async function request<T>(path: string, sudoToken?: string): Promise<T> {
  const response = await fetchWithAuthRefresh(`${getBaseUrl()}/backups/webdav${path}`, {
    method: sudoToken ? "POST" : "GET",
    headers: {
      ...(getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {}),
      ...(sudoToken ? { "X-Sudo-Token": sudoToken } : {}),
    },
  }, getBaseUrl());
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

export const backupWebDavApi = {
  config: () => request<{ enabled: boolean; configured: boolean; uploadOnAutoBackup: boolean; endpoint?: string; remotePath?: string }>(""),
  upload: (filename: string, token: string) => request(`/upload/${encodeURIComponent(filename)}`, token),
  list: () => request<RemoteBackup[]>("/files"),
  import: (filename: string, token: string) => request<{ filename: string }>(`/import/${encodeURIComponent(filename)}`, token),
};
