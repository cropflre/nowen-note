/**
 * Extension Center view model.
 *
 * Pure functions that merge the server's verified Registry indexes, installed
 * plugin records and feature flags into display state. Nothing here grants or
 * stores anything: the server re-checks every install, permission and enable
 * request, and this module never caches install state on the client.
 */
import type { InstalledPlugin, RegistryIndexDocument, RegistryIndexExtension, RegistryIndexVersion, RegistrySource } from "./pluginApi";

export type ExtensionCategory = "editor" | "workbench" | "productivity" | "ai" | "appearance" | "automation" | "import" | "other";
export const EXTENSION_CATEGORIES: readonly ExtensionCategory[] = ["editor", "workbench", "productivity", "ai", "appearance", "automation", "import", "other"];

const CATEGORY_ALIASES: Record<Exclude<ExtensionCategory, "other">, readonly string[]> = {
  editor: ["editor", "editing", "writing", "markdown", "text", "编辑器", "写作"],
  workbench: ["workbench", "dashboard", "widget", "widgets", "工作台", "看板"],
  productivity: ["productivity", "tasks", "task", "templates", "template", "notes", "效率", "任务", "模板"],
  ai: ["ai", "llm", "assistant", "智能", "人工智能"],
  appearance: ["appearance", "theme", "themes", "外观", "主题"],
  automation: ["automation", "workflow", "workflows", "webhook", "自动化"],
  import: ["import", "capture", "clipper", "migration", "export", "导入", "采集", "剪藏", "迁移"],
};

/** Map Registry / Manifest category strings onto the Extension Center tabs; unknown values become "other". */
export function mapExtensionCategory(values: ReadonlyArray<string | null | undefined>): ExtensionCategory {
  for (const value of values) {
    const key = String(value || "").trim().toLowerCase();
    if (!key) continue;
    for (const [category, aliases] of Object.entries(CATEGORY_ALIASES)) {
      if (aliases.includes(key)) return category as ExtensionCategory;
    }
  }
  return "other";
}

type Triple = [number, number, number];
function parseVersion(value: string): Triple | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
function compareTriple(a: Triple, b: Triple): number {
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

/** Display-only mirror of the server's nowenVersionSatisfies (>=, <=, >, <, =, ^, ~ joined by spaces). */
export function nowenRangeSatisfies(range: string | undefined, current: string): boolean {
  const actual = parseVersion(current);
  const clauses = String(range || "").trim().split(/\s+/).filter(Boolean);
  if (!actual || clauses.length === 0) return false;
  return clauses.every((clause) => {
    const match = /^(>=|<=|>|<|=|\^|~)?(\d+\.\d+\.\d+)/.exec(clause);
    const expected = match ? parseVersion(match[2]) : null;
    if (!match || !expected) return false;
    const comparison = compareTriple(actual, expected);
    switch (match[1] || "=") {
      case ">=": return comparison >= 0;
      case "<=": return comparison <= 0;
      case ">": return comparison > 0;
      case "<": return comparison < 0;
      case "^": return actual[0] === expected[0] && comparison >= 0;
      case "~": return actual[0] === expected[0] && actual[1] === expected[1] && comparison >= 0;
      default: return comparison === 0;
    }
  });
}

/** Same ordering the server uses when it picks "latest". */
export function compareExtensionVersions(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

export type IncompatibleReason = "NOWEN_VERSION" | "RUNTIME_PLATFORM" | "NO_VERSIONS";
export interface InstallCandidate { latest?: RegistryIndexVersion; candidate?: RegistryIndexVersion; incompatibleReason?: IncompatibleReason }

/** Newest version this server can install; the server re-validates the chosen version. */
export function pickInstallCandidate(
  versions: readonly RegistryIndexVersion[],
  context: { nowenVersion: string; runtimePlatform?: "server" | "desktop-full" },
): InstallCandidate {
  const sorted = [...versions].sort((a, b) => compareExtensionVersions(b.version, a.version));
  if (sorted.length === 0) return { incompatibleReason: "NO_VERSIONS" };
  let reason: IncompatibleReason = "NOWEN_VERSION";
  for (const version of sorted) {
    if (!nowenRangeSatisfies(version.nowen, context.nowenVersion)) continue;
    const runtimes = version.runtimePlatform?.length ? version.runtimePlatform : version.platforms;
    if (context.runtimePlatform && runtimes?.length && !runtimes.includes(context.runtimePlatform)) { reason = "RUNTIME_PLATFORM"; continue; }
    return { latest: sorted[0], candidate: version };
  }
  return { latest: sorted[0], incompatibleReason: reason };
}

export type UiPlatform = "web" | "desktop" | "android" | "ios";
/** undefined = the package did not declare UI platforms. Registry metadata may use "mobile" for android/ios. */
export function uiPlatformSupported(declared: readonly string[] | undefined, current: UiPlatform): boolean | undefined {
  if (!declared?.length) return undefined;
  return declared.includes(current) || ((current === "android" || current === "ios") && declared.includes("mobile"));
}

export type PermissionRisk = "read" | "write" | "network" | "secrets";
const NETWORK_PERMISSIONS = new Set(["external:fetch"]);
const SECRET_PERMISSIONS = new Set(["secrets:use"]);
export function permissionRisk(permission: string): PermissionRisk {
  if (NETWORK_PERMISSIONS.has(permission)) return "network";
  if (SECRET_PERMISSIONS.has(permission)) return "secrets";
  return permission.endsWith(":read") ? "read" : "write";
}
const RISK_ORDER: Record<PermissionRisk, number> = { secrets: 0, network: 1, write: 2, read: 3 };
export function sortPermissionsByRisk(permissions: readonly string[]): string[] {
  return [...new Set(permissions)].sort((a, b) => RISK_ORDER[permissionRisk(a)] - RISK_ORDER[permissionRisk(b)] || a.localeCompare(b));
}

export type ExtensionInstallState = "builtin" | "not-installed" | "pending" | "enabled" | "disabled" | "error" | "incompatible";
export type ExtensionPrimaryAction = "open" | "install" | "review-enable" | "manage" | "needs-admin" | "unavailable";
export type ExtensionUnavailableReason = IncompatibleReason | "NODE_POLICY" | "SERVER_POLICY";

export interface ExtensionSourceRef { sourceId: string; sourceName: string; official: boolean }
export type BuiltinNavigation =
  | { type: "view"; view: "tasks" | "diary" | "mindmaps" | "ai-chat" }
  | { type: "path"; path: "/apps/dashboard" | "/apps/studio" };

export interface ExtensionListing {
  key: string;
  kind: "plugin" | "builtin";
  id: string;
  name: string;
  description: string;
  publisher?: string;
  category: ExtensionCategory;
  keywords: string[];
  /** Sources that list this plugin, official first. */
  sources: ExtensionSourceRef[];
  /** Shown as "official" only when it comes from a compiled-in trust root. */
  official: boolean;
  trustLevel?: string;
  runtime?: string;
  apiVersion?: number;
  latestVersion?: string;
  /** Nowen range of the version shown (the candidate, else the latest one). */
  requiredNowen?: string;
  candidate?: RegistryIndexVersion;
  installed?: InstalledPlugin;
  installState: ExtensionInstallState;
  primaryAction: ExtensionPrimaryAction;
  unavailableReason?: ExtensionUnavailableReason;
  /** Newer compatible version than the installed one. */
  updateVersion?: string;
  /** Declared permissions that the administrator has not granted yet. */
  ungrantedPermissions: string[];
  permissions: string[];
  externalHosts: string[];
  uiPlatforms?: string[];
  uiPlatformSupported?: boolean;
  hasAdvisory: boolean;
  repository?: string;
  homepage?: string;
  license?: string;
  publishedAt?: string;
  navigation?: BuiltinNavigation;
}

export interface BuiltinFeature { id: string; category: ExtensionCategory; navigation: BuiltinNavigation; requiresDashboard?: boolean }
/** Native Nowen capabilities. They can be opened, never installed or uninstalled. */
export const BUILTIN_FEATURES: readonly BuiltinFeature[] = [
  { id: "dashboard", category: "workbench", navigation: { type: "path", path: "/apps/dashboard" }, requiresDashboard: true },
  { id: "studio", category: "productivity", navigation: { type: "path", path: "/apps/studio" } },
  { id: "tasks", category: "productivity", navigation: { type: "view", view: "tasks" } },
  { id: "diary", category: "productivity", navigation: { type: "view", view: "diary" } },
  { id: "mindmaps", category: "productivity", navigation: { type: "view", view: "mindmaps" } },
  { id: "ai-chat", category: "ai", navigation: { type: "view", view: "ai-chat" } },
];

/**
 * Auditable editorial picks. Only IDs and an i18n reason key; never download counts, ratings or
 * reviews. Picks that are not present in the loaded catalog are simply not shown.
 */
export const FEATURED_EXTENSIONS: ReadonlyArray<{ key: string; reasonKey: string }> = [
  { key: "builtin:dashboard", reasonKey: "extensionCenter.featured.dashboard" },
  { key: "builtin:studio", reasonKey: "extensionCenter.featured.studio" },
  { key: "plugin:nowenlab.wechat-capture", reasonKey: "extensionCenter.featured.wechatCapture" },
];

export interface CatalogSourceResult { source: RegistrySource; index?: RegistryIndexDocument; error?: { code?: string; message: string } }
export interface BuildCatalogInput {
  sources: readonly CatalogSourceResult[];
  installed: readonly InstalledPlugin[];
  isAdmin: boolean;
  nowenVersion: string;
  runtimePlatform?: "server" | "desktop-full";
  uiPlatform: UiPlatform;
  nodeRuntimeAllowed?: boolean | null;
  dashboardAvailable: boolean;
  builtinText: (id: string) => { name: string; description: string; keywords?: string[] };
}

function sourceOrder(results: readonly CatalogSourceResult[]): CatalogSourceResult[] {
  return [...results].sort((a, b) => Number(b.source.official) - Number(a.source.official));
}

function primaryActionFor(listing: Pick<ExtensionListing, "installState" | "candidate" | "ungrantedPermissions" | "runtime" | "installed">, input: BuildCatalogInput): { action: ExtensionPrimaryAction; reason?: ExtensionUnavailableReason } {
  switch (listing.installState) {
    case "builtin": return { action: "open" };
    case "not-installed": {
      if (!listing.candidate) return { action: "unavailable" };
      if (!input.isAdmin) return { action: "needs-admin" };
      if (listing.runtime === "node-action" && input.nodeRuntimeAllowed !== true) return { action: "unavailable", reason: "NODE_POLICY" };
      return { action: "install" };
    }
    case "pending":
    case "disabled":
      if (!input.isAdmin) return { action: "needs-admin" };
      if (listing.installed?.compatibility?.allowed === false) return { action: "manage", reason: "SERVER_POLICY" };
      return { action: "review-enable" };
    case "enabled":
      return { action: "manage" };
    default:
      return input.isAdmin ? { action: "manage" } : { action: "needs-admin" };
  }
}

function hasInstalledAdvisory(record?: InstalledPlugin): boolean {
  return Boolean(record?.advisoryState && !["unknown", "clear"].includes(record.advisoryState));
}

function installStateOf(record?: InstalledPlugin): ExtensionInstallState {
  if (!record) return "not-installed";
  switch (record.status) {
    case "quarantined": return "pending";
    case "enabled": return "enabled";
    case "disabled": return "disabled";
    case "incompatible": return "incompatible";
    default: return "error";
  }
}

/** Merge verified catalogs, installed records and built-in features into one de-duplicated listing set. */
export function buildExtensionListings(input: BuildCatalogInput): ExtensionListing[] {
  const installedById = new Map(input.installed.map((plugin) => [plugin.id, plugin]));
  const entries = new Map<string, { extension: RegistryIndexExtension; refs: ExtensionSourceRef[]; advisory: boolean; official: boolean }>();
  for (const result of sourceOrder(input.sources)) {
    if (!result.index) continue;
    const advisories = new Set((result.index.advisories || []).filter((item) => !item.state || item.state === "active").map((item) => item.pluginId));
    for (const extension of result.index.extensions || []) {
      if (!extension?.id || !Array.isArray(extension.versions)) continue;
      const ref = { sourceId: result.source.id, sourceName: result.source.name, official: result.source.official };
      const existing = entries.get(extension.id);
      if (existing) {
        existing.refs.push(ref);
        existing.advisory ||= advisories.has(extension.id);
        continue;
      }
      entries.set(extension.id, {
        extension,
        refs: [ref],
        advisory: advisories.has(extension.id),
        official: result.source.official && (extension.trustLevel === "official" || extension.trustLevel === "verified"),
      });
    }
  }

  const listings: ExtensionListing[] = [];
  for (const [id, entry] of entries) {
    const installed = installedById.get(id);
    const { latest, candidate, incompatibleReason } = pickInstallCandidate(entry.extension.versions, input);
    const shown = candidate || latest;
    const installState = installStateOf(installed);
    const ungrantedPermissions = (installed?.permissions || []).filter((row) => !row.granted).map((row) => row.permission);
    const base = {
      installState, candidate, installed, ungrantedPermissions,
      runtime: shown?.runtime || installed?.runtime,
    };
    const { action, reason } = primaryActionFor(base, input);
    listings.push({
      key: `plugin:${id}`,
      kind: "plugin",
      id,
      name: entry.extension.name || installed?.name || id,
      description: entry.extension.description || installed?.description || "",
      publisher: entry.extension.publisher,
      category: mapExtensionCategory([entry.extension.category, ...(entry.extension.categories || []), installed?.category]),
      keywords: [...new Set([...(entry.extension.keywords || []), ...(installed?.keywords || [])])],
      sources: entry.refs,
      official: entry.official,
      trustLevel: entry.extension.trustLevel,
      runtime: base.runtime,
      apiVersion: shown?.apiVersion ?? installed?.apiVersion,
      latestVersion: latest?.version,
      requiredNowen: shown?.nowen,
      candidate,
      installed,
      installState,
      primaryAction: action,
      unavailableReason: reason || (action === "unavailable" ? incompatibleReason : undefined),
      updateVersion: installed && candidate && compareExtensionVersions(candidate.version, installed.version) > 0 ? candidate.version : undefined,
      ungrantedPermissions,
      permissions: sortPermissionsByRisk(installed ? installed.permissions.map((row) => row.permission) : shown?.permissions || []),
      externalHosts: [...(shown?.permissionConfig?.externalFetchHosts || [])],
      uiPlatforms: shown?.uiPlatform,
      uiPlatformSupported: uiPlatformSupported(shown?.uiPlatform, input.uiPlatform),
      hasAdvisory: entry.advisory || hasInstalledAdvisory(installed),
      repository: entry.extension.repository || installed?.repository,
      homepage: entry.extension.homepage || installed?.homepage,
      license: entry.extension.license || installed?.license,
      publishedAt: shown?.publishedAt,
    });
  }

  // Plugins installed from a package or a source that is no longer configured.
  for (const installed of input.installed) {
    if (entries.has(installed.id)) continue;
    const installState = installStateOf(installed);
    const ungrantedPermissions = installed.permissions.filter((row) => !row.granted).map((row) => row.permission);
    const { action, reason } = primaryActionFor({ installState, installed, ungrantedPermissions, runtime: installed.runtime }, input);
    listings.push({
      key: `plugin:${installed.id}`,
      kind: "plugin",
      id: installed.id,
      name: installed.name,
      description: installed.description,
      publisher: installed.publisher || undefined,
      category: mapExtensionCategory([installed.category]),
      keywords: installed.keywords || [],
      sources: [],
      official: false,
      trustLevel: installed.trustLevel,
      runtime: installed.runtime,
      apiVersion: installed.apiVersion,
      installed,
      installState,
      primaryAction: action,
      unavailableReason: reason,
      ungrantedPermissions,
      permissions: sortPermissionsByRisk(installed.permissions.map((row) => row.permission)),
      externalHosts: [],
      hasAdvisory: hasInstalledAdvisory(installed),
      repository: installed.repository,
      homepage: installed.homepage,
      license: installed.license,
    });
  }

  for (const feature of BUILTIN_FEATURES) {
    if (feature.requiresDashboard && !input.dashboardAvailable) continue;
    const text = input.builtinText(feature.id);
    listings.push({
      key: `builtin:${feature.id}`,
      kind: "builtin",
      id: feature.id,
      name: text.name,
      description: text.description,
      category: feature.category,
      keywords: text.keywords || [],
      sources: [],
      official: true,
      installState: "builtin",
      primaryAction: "open",
      ungrantedPermissions: [],
      permissions: [],
      externalHosts: [],
      hasAdvisory: false,
      navigation: feature.navigation,
    });
  }
  return listings;
}

export interface ListingFilter { query?: string; category?: ExtensionCategory | "all"; installedOnly?: boolean }

/** Case-insensitive AND search over name, ID, description, publisher, keywords and the category label. */
export function filterExtensionListings(
  listings: readonly ExtensionListing[],
  filter: ListingFilter,
  categoryLabel: (category: ExtensionCategory) => string = (category) => category,
): ExtensionListing[] {
  const tokens = String(filter.query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  return listings.filter((listing) => {
    if (filter.category && filter.category !== "all" && listing.category !== filter.category) return false;
    if (filter.installedOnly && (listing.kind !== "plugin" || listing.installState === "not-installed")) return false;
    if (!tokens.length) return true;
    const haystack = [listing.name, listing.id, listing.description, listing.publisher || "", categoryLabel(listing.category), ...listing.keywords]
      .join("\n").toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/** Editorial picks that actually exist in the current listing set, in curated order. */
export function pickFeaturedListings(listings: readonly ExtensionListing[]): Array<{ listing: ExtensionListing; reasonKey: string }> {
  const byKey = new Map(listings.map((listing) => [listing.key, listing]));
  return FEATURED_EXTENSIONS.flatMap((item) => {
    const listing = byKey.get(item.key);
    return listing ? [{ listing, reasonKey: item.reasonKey }] : [];
  });
}
