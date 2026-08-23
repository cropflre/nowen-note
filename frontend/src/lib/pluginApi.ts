import { getBaseUrl } from "./api.impl";
import { fetchWithAuthRefresh, getAccessToken } from "./authSession";

export interface PluginPermissionRow {
  permission: string;
  configJson: string;
  granted: number;
}

export interface PluginAction {
  id: string;
  name: string;
  description?: string;
  execution?: "interactive" | "background";
  input?: Record<string, { type: string; required?: boolean; description?: string }>;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  source: string;
  trustLevel: string;
  status: "quarantined" | "disabled" | "enabled" | "error" | "incompatible";
  checksum: string;
  lastError?: string | null;
  actions: PluginAction[];
  permissions: PluginPermissionRow[];
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  const response = await fetchWithAuthRefresh(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(init.headers || {}),
    },
  }, getBaseUrl());
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { code: payload.code, status: response.status });
  return payload as T;
}

export const pluginApi = {
  list: () => request<InstalledPlugin[]>("/api/plugins"),
  get: (id: string) => request<InstalledPlugin>(`/api/plugins/${encodeURIComponent(id)}`),
  install: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ success: true; plugin: InstalledPlugin }>("/api/plugins/install", { method: "POST", body: form });
  },
  grant: (id: string, granted: string[]) => request(`/api/plugins/${encodeURIComponent(id)}/permissions`, { method: "PUT", body: JSON.stringify({ granted }) }),
  enable: (id: string) => request(`/api/plugins/${encodeURIComponent(id)}/enable`, { method: "POST" }),
  disable: (id: string) => request(`/api/plugins/${encodeURIComponent(id)}/disable`, { method: "POST" }),
  reload: (id: string) => request(`/api/plugins/${encodeURIComponent(id)}/reload`, { method: "POST" }),
  uninstall: (id: string) => request(`/api/plugins/${encodeURIComponent(id)}`, { method: "DELETE" }),
  execute: (pluginId: string, actionId: string, input: Record<string, unknown>) => request<{ success: boolean; executionId: string; data: unknown }>(`/api/plugins/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(actionId)}/execute`, { method: "POST", body: JSON.stringify({ input }) }),
  executions: (id: string) => request<any[]>(`/api/plugins/${encodeURIComponent(id)}/executions`),
  getDeveloperMode: () => request<{ enabled: boolean; available: boolean }>("/api/plugins/developer-mode"),
  setDeveloperMode: (enabled: boolean) => request<{ enabled: boolean }>("/api/plugins/developer-mode", { method: "PUT", body: JSON.stringify({ enabled }) }),
  loadDevelopment: (directory: string) => request("/api/plugins/dev/load", { method: "POST", body: JSON.stringify({ directory }) }),
};
