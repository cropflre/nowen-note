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
  previousVersion?: string | null;
  publisher?: string | null;
  signatureState?: string;
  advisoryState?: string;
  nodeRuntimeConfirmedAt?: string | null;
  nodeRuntimeConfirmedBy?: string | null;
  compatibility?:
    | { allowed: true; runner: "node-action" | "sandbox-js" }
    | { allowed: false; code: string; reason: string; confirmationRequired?: true };
  updatePolicy?: "manual" | "notify" | "automatic";
  pinnedVersion?: string | null;
  probationRemaining?: number;
  autoRollbackReason?: string | null;
  contributes?: {
    settings?: Array<{ key: string; title: string; type: "string" | "number" | "boolean" | "select"; description?: string; options?: Array<string | number>; default?: string | number | boolean; secret?: boolean }>;
    automationTemplates?: Array<{ id: string; title: string; description?: string }>;
    commands?: Array<{ id: string; title: string; action: string; category?: string }>;
    menus?: Array<{ location: string; command: string }>;
  };
  versions?: PluginVersion[];
  permissionDiff?: { added: string[]; removed: string[] };
  category?: string;
  keywords?: string[];
  repository?: string;
  homepage?: string;
  license?: string;
  connections?: PluginConnection[];
  actions: PluginAction[];
  permissions: PluginPermissionRow[];
}

export interface PluginVersion { version: string; checksum: string; source: string; trustLevel: string; status: string; installedAt: string; verifiedAt?: string | null }
export interface PluginConnection { id: string; name: string; type: "bearer" | "api-key-header" | "basic"; headerName?: string; description?: string; configured?: boolean }
export interface PluginExecution { id: string; actionId: string; status: string; durationMs?: number | null; errorMessage?: string | null; progressCurrent?: number | null; progressTotal?: number | null; progressMessage?: string | null }
export interface RegistrySource { id: string; name: string; url: string; official?: boolean }
export interface RegistryPlugin { id: string; name: string; description?: string; category?: string; keywords?: string[]; latestVersion: string; trustLevel?: string; repository?: string }
export interface PluginUpdate { pluginId: string; currentVersion: string; availableVersion: string; permissionDiff: { added: string[] }; confirmationRequired: boolean }

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
  if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), {
    code: payload.code,
    status: response.status,
    confirmNodeRuntimeAllowed: payload.confirmNodeRuntimeAllowed === true,
  });
  return payload as T;
}

export const pluginApi = {
  list: () => request<InstalledPlugin[]>("/plugins"),
  actions: () => request<Array<PluginAction & { pluginId: string; actionId: string }>>("/plugins/actions"),
  contributions: () => request<Array<Record<string, unknown>>>("/plugins/contributions"),
  get: (id: string) => request<InstalledPlugin>(`/plugins/${encodeURIComponent(id)}`),
  install: (file: File, confirmNodeRuntime = false) => {
    const form = new FormData();
    form.append("file", file);
    if (confirmNodeRuntime) form.append("confirmNodeRuntime", "true");
    return request<{ success: true; plugin: InstalledPlugin }>("/plugins/install", { method: "POST", body: form });
  },
  grant: (id: string, granted: string[]) => request(`/plugins/${encodeURIComponent(id)}/permissions`, { method: "PUT", body: JSON.stringify({ granted }) }),
  enable: (id: string) => request(`/plugins/${encodeURIComponent(id)}/enable`, { method: "POST" }),
  disable: (id: string) => request(`/plugins/${encodeURIComponent(id)}/disable`, { method: "POST" }),
  reload: (id: string) => request(`/plugins/${encodeURIComponent(id)}/reload`, { method: "POST" }),
  uninstall: (id: string) => request(`/plugins/${encodeURIComponent(id)}`, { method: "DELETE" }),
  execute: (pluginId: string, actionId: string, input: Record<string, unknown>) => request<{ success: boolean; executionId: string; data: unknown }>(`/plugins/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(actionId)}/execute`, { method: "POST", body: JSON.stringify({ input }) }),
  executions: (id: string) => request<PluginExecution[]>(`/plugins/${encodeURIComponent(id)}/executions`),
  versions: (id: string) => request<PluginVersion[]>(`/plugins/${encodeURIComponent(id)}/versions`),
  rollback: (id: string, version?: string) => request(`/plugins/${encodeURIComponent(id)}/rollback`, { method: "POST", body: JSON.stringify({ version }) }),
  connections: (id: string) => request<PluginConnection[]>(`/plugins/${encodeURIComponent(id)}/connections`),
  setConnection: (id: string, name: string, value: string) => request(`/plugins/${encodeURIComponent(id)}/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) }),
  removeConnection: (id: string, name: string) => request(`/plugins/${encodeURIComponent(id)}/secrets/${encodeURIComponent(name)}`, { method: "DELETE" }),
  registrySources: () => request<RegistrySource[]>("/plugins/registry/sources"),
  setRegistrySources: (sources: RegistrySource[]) => request<RegistrySource[]>("/plugins/registry/sources", { method: "PUT", body: JSON.stringify({ sources }) }),
  registryCatalog: (source = "official") => request<RegistryPlugin[]>(`/plugins/registry/catalog?source=${encodeURIComponent(source)}`),
  installFromRegistry: (sourceId: string, pluginId: string, version?: string) => request("/plugins/registry/install", { method: "POST", body: JSON.stringify({ sourceId, pluginId, version }) }),
  getDeveloperMode: () => request<{ enabled: boolean; available: boolean }>("/plugins/developer-mode"),
  setDeveloperMode: (enabled: boolean) => request<{ enabled: boolean }>("/plugins/developer-mode", { method: "PUT", body: JSON.stringify({ enabled }) }),
  loadDevelopment: (directory: string, confirmNodeRuntime = false) => request("/plugins/dev/load", { method: "POST", body: JSON.stringify({ directory, confirmNodeRuntime }) }),
  checkUpdates: (source = "official-v2") => request<PluginUpdate[]>(`/plugins/ecosystem/updates?source=${encodeURIComponent(source)}`),
  applyUpdate: (sourceId: string, pluginId: string, version: string, confirmed = false) => request("/plugins/ecosystem/update", { method: "POST", body: JSON.stringify({ sourceId, pluginId, version, confirmed }) }),
  setUpdatePolicy: (id: string, policy: "manual" | "notify" | "automatic", pinnedVersion?: string | null) => request(`/plugins/${encodeURIComponent(id)}/update-policy`, { method: "PUT", body: JSON.stringify({ policy, pinnedVersion }) }),
  settings: (id: string) => request<Record<string, unknown>>(`/plugins/${encodeURIComponent(id)}/settings`),
  setSettings: (id: string, values: Record<string, unknown>) => request<Record<string, unknown>>(`/plugins/${encodeURIComponent(id)}/settings`, { method: "PUT", body: JSON.stringify(values) }),
  installAutomationTemplate: (id: string, templateId: string) => request(`/plugins/${encodeURIComponent(id)}/automation-templates/${encodeURIComponent(templateId)}/install`, { method: "POST" }),
};
