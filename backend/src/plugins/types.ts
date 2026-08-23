export const PLUGIN_API_VERSION = 1;
export const NOWEN_VERSION = "1.5.0";

export const PLUGIN_PERMISSIONS = [
  "notes:read", "notes:write",
  "notebooks:read", "notebooks:write",
  "tags:read", "tags:write",
  "tasks:read", "tasks:write",
  "attachments:read", "attachments:write",
  "diary:read", "diary:write",
  "mindmaps:read", "mindmaps:write",
  "plugin-storage:read", "plugin-storage:write",
  "external:fetch", "secrets:use",
] as const;

export type PluginPermission = typeof PLUGIN_PERMISSIONS[number];
export type PluginStatus = "quarantined" | "disabled" | "enabled" | "error" | "incompatible";
export type PluginSource = "package" | "official" | "dev" | "restore";
export type PluginTrustLevel = "official" | "verified" | "community" | "developer";

export interface PluginActionInputField {
  type: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  description?: string;
  enum?: Array<string | number | boolean>;
  default?: unknown;
}

export interface PluginActionManifest {
  id: string;
  name: string;
  description?: string;
  execution?: "interactive" | "background";
  input?: Record<string, PluginActionInputField>;
}

export interface PluginManifestV1 {
  id: string;
  name: string;
  description: string;
  version: string;
  apiVersion: 1;
  engines: { nowen: string };
  runtime: "node-action";
  main: string;
  author?: { name: string; url?: string };
  permissions: PluginPermission[];
  permissionConfig?: {
    externalFetchHosts?: string[];
  };
  actions: PluginActionManifest[];
}

export interface PluginRegistryRecord {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  runtime: string;
  main: string;
  source: PluginSource;
  trustLevel: PluginTrustLevel;
  status: PluginStatus;
  checksum: string;
  manifestJson: string;
  installedPath: string;
  installedBy: string | null;
  installedAt: string;
  updatedAt: string;
  lastError: string | null;
}

export interface PluginExecutionContext {
  executionId: string;
  pluginId: string;
  actionId: string;
  userId: string;
  workspaceId: string | null;
}

export interface PluginExecutionResult {
  success: boolean;
  data?: unknown;
  text?: string;
  error?: string;
}

export interface HostCall {
  method: string;
  args: unknown;
}
