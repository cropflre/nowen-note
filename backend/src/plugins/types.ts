export const PLUGIN_API_VERSION = 2;
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
export type PluginSource = "package" | "official" | "registry" | "dev" | "restore";
export type PluginTrustLevel = "official" | "verified" | "community" | "developer";

export interface PluginConnectionManifest {
  id: string;
  name: string;
  type: "bearer" | "api-key-header" | "basic";
  headerName?: string;
  description?: string;
}

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
  idempotent?: boolean;
  retryable?: boolean;
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
  category?: string;
  keywords?: string[];
  repository?: string;
  homepage?: string;
  license?: string;
  icon?: string;
  screenshots?: string[];
  connections?: PluginConnectionManifest[];
  output?: Record<string, unknown>;
  permissions: PluginPermission[];
  permissionConfig?: {
    externalFetchHosts?: string[];
  };
  actions: PluginActionManifest[];
  events?: string[];
  eventHandlers?: Array<{ event: string; action: string }>;
}

export interface PluginCommandContribution { id: string; title: string; action: string; category?: string }
export interface PluginMenuContribution { location: "commandPalette" | "note.contextMenu" | "notebook.contextMenu" | "editor.toolbar.actions" | "attachment.contextMenu" | "task.contextMenu" | "settings.plugin" | "automation.template"; command: string }
export interface PluginSettingContribution { key: string; title: string; type: "string" | "number" | "boolean" | "select"; description?: string; options?: Array<string | number>; default?: string | number | boolean; secret?: boolean }
export interface PluginAutomationTemplateContribution { id: string; title: string; file: string; description?: string }

export interface PluginManifestV2 {
  id: string;
  name: string;
  description: string;
  version: string;
  apiVersion: 2;
  publisher: string;
  engines: { nowen: string };
  runtime: "sandbox-js" | "node-action";
  main: string;
  categories: string[];
  keywords?: string[];
  repository: string;
  homepage?: string;
  license: string;
  icon?: string;
  screenshots?: string[];
  platforms?: Array<"server" | "desktop-full">;
  runtimePlatform?: Array<"server" | "desktop-full">;
  uiPlatform?: Array<"web" | "desktop" | "android" | "ios">;
  connections?: PluginConnectionManifest[];
  output?: Record<string, unknown>;
  permissions: PluginPermission[];
  permissionConfig?: { externalFetchHosts?: string[] };
  actions: PluginActionManifest[];
  events?: string[];
  eventHandlers?: Array<{ event: string; action: string }>;
  contributes?: {
    commands?: PluginCommandContribution[];
    menus?: PluginMenuContribution[];
    settings?: PluginSettingContribution[];
    automationTemplates?: PluginAutomationTemplateContribution[];
  };
  extensionDependencies?: Record<string, string>;
}

export type PluginManifest = PluginManifestV1 | PluginManifestV2;

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
  previousVersion: string | null;
  publisher?: string | null;
  signatureState?: string;
  advisoryState?: string;
  updatePolicy?: string;
  pinnedVersion?: string | null;
  probationVersion?: string | null;
  probationRemaining?: number;
  autoRollbackReason?: string | null;
}

export interface PluginVersionRecord {
  pluginId: string;
  version: string;
  manifestJson: string;
  checksum: string;
  installedPath: string;
  source: PluginSource;
  trustLevel: PluginTrustLevel;
  status: string;
  installedAt: string;
  verifiedAt: string | null;
  publisherKeyId?: string | null;
  signature?: string | null;
  signatureState?: string;
  artifactUrl?: string | null;
}

export interface PluginExecutionContext {
  executionId: string;
  pluginId: string;
  actionId: string;
  userId: string;
  workspaceId: string | null;
  source?: "user" | "plugin" | "workflow" | "sync" | "system";
  sourceId?: string;
  correlationId?: string;
  causationId?: string;
  depth?: number;
  idempotencyKey?: string;
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

export interface PluginProgress {
  current?: number;
  total?: number;
  message?: string;
}
