export const PLUGIN_API_VERSION = 2;
export const NOWEN_VERSION = "1.5.0";
export const EXTENSION_V21_TARGET_NOWEN_VERSION = "1.6.0";

export interface ExtensionPlatformFeatureFlags {
  extensionsV21: boolean;
  pluginStudio: boolean;
  fileProcessingExtensions: boolean;
  experimentalDocumentTypes: boolean;
}

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
export type PluginLifecycleState =
  | "installed"
  | "preflight"
  | "probation"
  | "stable"
  | "rollback_pending"
  | "rolling_back"
  | "disabled";
export type PluginUpdateStage =
  | "downloaded"
  | "verified"
  | "staged"
  | "preflight"
  | "switching"
  | "probation"
  | "rollback_pending"
  | "rolling_back"
  | "stable"
  | "failed"
  | "rolled_back";

export interface RegistryMetadataState {
  sourceId: string;
  highestSeenSequence: number;
  documentDigest: string;
  generatedAt: string;
  expiresAt: string;
  verifiedAt: string;
  signerKeyId: string;
  documentJson: string;
}

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
export type PluginNoteThemeFontCategory = "system" | "sans" | "serif" | "mono";
export interface PluginNoteThemeTokens {
  canvasBackground?: string;
  contentBackground?: string;
  contentText?: string;
  mutedText?: string;
  headingText?: string;
  linkColor?: string;
  linkWeight?: number;
  quoteBackground?: string;
  quoteBorder?: string;
  tableBorder?: string;
  tableHeaderBackground?: string;
  tableStripeBackground?: string;
  codeBackground?: string;
  inlineCodeBackground?: string;
  contentMaxWidth?: number;
  contentPaddingInline?: number;
  contentPaddingBlock?: number;
  fontCategory?: PluginNoteThemeFontCategory;
  fontSize?: number;
  lineHeight?: number;
  letterSpacing?: number;
  paragraphSpacing?: number;
  radius?: number;
  controlBackground?: string;
  controlBorder?: string;
}
export interface PluginNoteThemeContribution {
  id: string;
  name: string;
  description?: string;
  base?: "nowen.default";
  modes: { light: PluginNoteThemeTokens; dark?: PluginNoteThemeTokens };
}

export interface PluginContributionManifest {
  commands?: PluginCommandContribution[];
  menus?: PluginMenuContribution[];
  settings?: PluginSettingContribution[];
  automationTemplates?: PluginAutomationTemplateContribution[];
  noteThemes?: PluginNoteThemeContribution[];
}

export interface PluginDeclarativeContributionManifest {
  settings?: PluginSettingContribution[];
  automationTemplates?: PluginAutomationTemplateContribution[];
  noteThemes?: PluginNoteThemeContribution[];
}

interface PluginManifestV2Base {
  id: string;
  name: string;
  description: string;
  version: string;
  apiVersion: 2;
  publisher: string;
  engines: { nowen: string };
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
  output?: Record<string, unknown>;
  permissions: PluginPermission[];
  permissionConfig?: { externalFetchHosts?: string[] };
  extensionDependencies?: Record<string, string>;
}

export interface PluginManifestV2Executable extends PluginManifestV2Base {
  runtime: "sandbox-js" | "node-action";
  main: string;
  connections?: PluginConnectionManifest[];
  actions: PluginActionManifest[];
  events?: string[];
  eventHandlers?: Array<{ event: string; action: string }>;
  contributes?: PluginContributionManifest;
}

export interface PluginManifestV2Declarative extends PluginManifestV2Base {
  runtime: "declarative";
  contributes: PluginDeclarativeContributionManifest;
  permissions: [];
  main?: never;
  connections?: never;
  actions?: never;
  events?: never;
  eventHandlers?: never;
}

export type PluginManifestV2 = PluginManifestV2Executable | PluginManifestV2Declarative;
export type PluginManifest = PluginManifestV1 | PluginManifestV2;

export function isDeclarativePluginManifest(manifest: PluginManifest): manifest is PluginManifestV2Declarative {
  return manifest.apiVersion === 2 && manifest.runtime === "declarative";
}

export function pluginManifestMain(manifest: PluginManifest): string {
  return isDeclarativePluginManifest(manifest) ? "" : manifest.main;
}

export function pluginManifestActions(manifest: PluginManifest): PluginActionManifest[] {
  return isDeclarativePluginManifest(manifest) ? [] : manifest.actions;
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
  previousVersion: string | null;
  publisher?: string | null;
  signatureState?: string;
  advisoryState?: string;
  updatePolicy?: string;
  pinnedVersion?: string | null;
  probationVersion?: string | null;
  probationRemaining?: number;
  autoRollbackReason?: string | null;
  lifecycleState: PluginLifecycleState;
  previousStableVersion: string | null;
  activeOperationId: string | null;
  stateUpdatedAt: string;
  nodeRuntimeConfirmedAt: string | null;
  nodeRuntimeConfirmedBy: string | null;
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
