import { getBaseUrl } from "./api.impl";
import { fetchWithAuthRefresh, getAccessToken } from "./authSession";

export interface ExtensionPlatformFeatureFlags {
  extensionsV21: boolean;
  pluginStudio: boolean;
  fileProcessingExtensions: boolean;
  experimentalDocumentTypes: boolean;
  currentNowenVersion: string;
  targetNowenVersion: string;
}

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

export interface PluginNoteThemeTokens {
  surface?: string; text?: string; heading?: string; muted?: string; border?: string; accent?: string;
  accentHover?: string; inlineCodeBackground?: string; inlineCodeText?: string; preBackground?: string; preText?: string;
  quoteBorder?: string; quoteText?: string; softBackground?: string; tableStripe?: string; markBackground?: string;
  selection?: string; contentMaxWidth?: string; lineHeight?: string;
}
export interface PluginNoteThemeContribution {
  id: string; name: string; description?: string; base?: "nowen.default";
  modes: { light: PluginNoteThemeTokens; dark?: PluginNoteThemeTokens };
}
export interface PluginStaticInputField { id: string; label?: string; type: "string" | "number" | "boolean"; required?: boolean; default?: string | number | boolean }
export interface PluginNoteTemplateContribution {
  id: string; name: string; description?: string; contentFormat: "markdown" | "tiptap-json"; body: string;
  variables?: PluginStaticInputField[]; suggestedTags?: string[]; documentTypes?: Array<"note" | "markdown">;
}
export interface PluginPromptPackContribution {
  id: string; name: string; description?: string; prompt: string; inputs?: PluginStaticInputField[];
  context?: Array<"title" | "note" | "selection" | "tags">;
  outputMode?: "text" | "markdown" | "replace-selection" | "append";
  uiPlatform?: Array<"web" | "desktop" | "android" | "ios">;
}

export interface PluginContributionRecord {
  pluginId: string;
  publisher?: string;
  noteThemes?: PluginNoteThemeContribution[];
  noteTemplates?: PluginNoteTemplateContribution[];
  promptPacks?: PluginPromptPackContribution[];
  [key: string]: unknown;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  description: string;
  version: string;
  runtime: "node-action" | "sandbox-js" | "declarative";
  executionMode?: "executable" | "declarative-zero-code";
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
    | { allowed: true; runner: "node-action" | "sandbox-js" | "declarative" }
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
    noteThemes?: PluginNoteThemeContribution[];
    noteTemplates?: PluginNoteTemplateContribution[];
    promptPacks?: PluginPromptPackContribution[];
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
export interface RegistrySource {
  id: string;
  name: string;
  indexUrl: string;
  official: boolean;
  enabled: boolean;
  registryKeyId: string | null;
  registryPublicKey: string | null;
}
export interface RegistryPlugin {
  id: string;
  publisher: string;
  name: string;
  description?: string;
  category?: string;
  keywords?: string[];
  latestVersion: string;
  trustLevel?: string;
  repository?: string;
}
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

export const PLUGIN_CONTRIBUTIONS_CHANGED_EVENT = "nowen:plugin-contributions-changed";

async function contributionMutation<T>(operation: Promise<T>): Promise<T> {
  const result = await operation;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT));
  return result;
}

export const pluginApi = {
  features: () => request<ExtensionPlatformFeatureFlags>("/plugins/features"),
  list: () => request<InstalledPlugin[]>("/plugins"),
  actions: () => request<Array<PluginAction & { pluginId: string; actionId: string }>>("/plugins/actions"),
  contributions: () => request<PluginContributionRecord[]>("/plugins/contributions"),
  get: (id: string) => request<InstalledPlugin>(`/plugins/${encodeURIComponent(id)}`),
  install: (file: File, confirmNodeRuntime = false) => {
    const form = new FormData();
    form.append("file", file);
    if (confirmNodeRuntime) form.append("confirmNodeRuntime", "true");
    return contributionMutation(request<{ success: true; plugin: InstalledPlugin }>("/plugins/install", { method: "POST", body: form }));
  },
  grant: (id: string, granted: string[]) => request(`/plugins/${encodeURIComponent(id)}/permissions`, { method: "PUT", body: JSON.stringify({ granted }) }),
  enable: (id: string) => contributionMutation(request(`/plugins/${encodeURIComponent(id)}/enable`, { method: "POST" })),
  disable: (id: string) => contributionMutation(request(`/plugins/${encodeURIComponent(id)}/disable`, { method: "POST" })),
  reload: (id: string) => contributionMutation(request(`/plugins/${encodeURIComponent(id)}/reload`, { method: "POST" })),
  uninstall: (id: string) => contributionMutation(request(`/plugins/${encodeURIComponent(id)}`, { method: "DELETE" })),
  execute: (pluginId: string, actionId: string, input: Record<string, unknown>) => request<{ success: boolean; executionId: string; data: unknown }>(`/plugins/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(actionId)}/execute`, { method: "POST", body: JSON.stringify({ input }) }),
  executions: (id: string) => request<PluginExecution[]>(`/plugins/${encodeURIComponent(id)}/executions`),
  versions: (id: string) => request<PluginVersion[]>(`/plugins/${encodeURIComponent(id)}/versions`),
  rollback: (id: string, version?: string) => contributionMutation(request(`/plugins/${encodeURIComponent(id)}/rollback`, { method: "POST", body: JSON.stringify({ version }) })),
  connections: (id: string) => request<PluginConnection[]>(`/plugins/${encodeURIComponent(id)}/connections`),
  setConnection: (id: string, name: string, value: string) => request(`/plugins/${encodeURIComponent(id)}/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) }),
  removeConnection: (id: string, name: string) => request(`/plugins/${encodeURIComponent(id)}/secrets/${encodeURIComponent(name)}`, { method: "DELETE" }),
  registrySources: () => request<RegistrySource[]>("/plugins/ecosystem/sources"),
  setRegistrySource: (source: Pick<RegistrySource, "id" | "name" | "indexUrl" | "registryKeyId" | "registryPublicKey"> & { enabled?: boolean }) => request<RegistrySource[]>("/plugins/ecosystem/sources", { method: "PUT", body: JSON.stringify(source) }),
  registryCatalog: async (source = "official-v2") => {
    const index = await request<{ extensions: Array<Omit<RegistryPlugin, "latestVersion"> & { versions: Array<{ version: string }> }> }>(`/plugins/ecosystem/catalog?source=${encodeURIComponent(source)}`);
    return index.extensions.map((extension) => ({
      ...extension,
      latestVersion: [...extension.versions]
        .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }))[0]?.version || "",
    }));
  },
  installFromRegistry: (sourceId: string, pluginId: string, version?: string) => contributionMutation(request("/plugins/ecosystem/install", { method: "POST", body: JSON.stringify({ sourceId, pluginId, version }) })),
  getDeveloperMode: () => request<{ enabled: boolean; available: boolean }>("/plugins/developer-mode"),
  setDeveloperMode: (enabled: boolean) => request<{ enabled: boolean }>("/plugins/developer-mode", { method: "PUT", body: JSON.stringify({ enabled }) }),
  loadDevelopment: (directory: string, confirmNodeRuntime = false) => contributionMutation(request("/plugins/dev/load", { method: "POST", body: JSON.stringify({ directory, confirmNodeRuntime }) })),
  checkUpdates: (source = "official-v2") => request<PluginUpdate[]>(`/plugins/ecosystem/updates?source=${encodeURIComponent(source)}`),
  applyUpdate: (sourceId: string, pluginId: string, version: string, confirmed = false) => contributionMutation(request("/plugins/ecosystem/update", { method: "POST", body: JSON.stringify({ sourceId, pluginId, version, confirmed }) })),
  setUpdatePolicy: (id: string, policy: "manual" | "notify" | "automatic", pinnedVersion?: string | null) => request(`/plugins/${encodeURIComponent(id)}/update-policy`, { method: "PUT", body: JSON.stringify({ policy, pinnedVersion }) }),
  settings: (id: string) => request<Record<string, unknown>>(`/plugins/${encodeURIComponent(id)}/settings`),
  setSettings: (id: string, values: Record<string, unknown>) => request<Record<string, unknown>>(`/plugins/${encodeURIComponent(id)}/settings`, { method: "PUT", body: JSON.stringify(values) }),
  installAutomationTemplate: (id: string, templateId: string) => request(`/plugins/${encodeURIComponent(id)}/automation-templates/${encodeURIComponent(templateId)}/install`, { method: "POST" }),
  createNoteFromTemplate: (id: string, templateId: string, input: { workspaceId?: string | null; parentId?: string | null; values?: Record<string, unknown> }) => request<{ success: true; noteId: string; node: unknown }>("/plugins/" + encodeURIComponent(id) + "/note-templates/" + encodeURIComponent(templateId) + "/create", { method: "POST", body: JSON.stringify(input) }),
};
