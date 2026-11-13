import { PLUGIN_PERMISSIONS, type PluginPermission } from "./types.js";

// Packaged UI files must not be interpreted as Node/QuickJS plugin actions.
// The isolated app Host/Bridge ships in 1.5.3; unfinished capabilities stay opt-in.
export const APPLICATION_V3_API_VERSION = 3 as const;
export const APPLICATION_V3_TARGET_NOWEN = "1.5.3";
export type AppPlatformV3 = "web" | "desktop" | "android" | "ios";

const PLUGIN_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const PAGE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_PACKAGED_HTML = /^ui\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.html$/;
const SAFE_UI_ASSET = /^ui\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:[.-][A-Za-z0-9_-]+)*\.(?:html|js|css|json|png|jpg|jpeg|webp|gif|woff2)$/;
const ALLOWED_PERMISSIONS = new Set<string>(PLUGIN_PERMISSIONS);
const PLATFORMS = new Set<AppPlatformV3>(["web", "desktop", "android", "ios"]);
const TRUE = new Set(["1", "true", "yes", "on", "enabled"]);

export interface AppPageDeclarationV3 {
  id: string;
  title: string;
  entry: string;
  platforms: AppPlatformV3[];
  requiredPermissions: PluginPermission[];
}

export interface RegisteredAppPageV3 extends AppPageDeclarationV3 {
  pluginId: string;
  runtimeId: string;
  route: string;
}

export interface ApplicationV3FeatureFlags {
  core: boolean;
  appPages: boolean;
  dashboardWidgets: boolean;
  pluginData: boolean;
  inspectors: boolean;
}

function envEnabled(name: string, defaultValue = false): boolean {
  const value = process.env[name]?.trim();
  return value ? TRUE.has(value.toLowerCase()) : defaultValue;
}

export function getApplicationV3FeatureFlags(): Readonly<ApplicationV3FeatureFlags> {
  // Legacy flags remain explicit shutdown overrides without enabling unrelated V2.1 features.
  const core = envEnabled("NOWEN_EXTENSIONS_V21", true) && envEnabled("NOWEN_EXTENSION_V3_CORE", true);
  const appPages = core && ["NOWEN_UI_EXTENSIONS", "NOWEN_UI_LAYOUT_EDITOR", "NOWEN_SANDBOXED_PLUGIN_UI", "NOWEN_EXTENSION_V3_APP_PAGES"].every(name => envEnabled(name, true));
  return Object.freeze({
    core,
    appPages,
    dashboardWidgets: appPages && envEnabled("NOWEN_EXTENSION_V3_DASHBOARD_WIDGETS", true),
    pluginData: core && envEnabled("NOWEN_EXTENSION_V3_PLUGIN_DATA", true),
    inspectors: appPages && envEnabled("NOWEN_EXTENSION_V3_INSPECTORS"),
  });
}

function invalid(reason: string): never {
  throw Object.assign(new Error(reason), { code: "PLUGIN_V3_APP_INVALID" });
}

export function validateUiAssetPathV3(entry: unknown): string {
  if (typeof entry !== "string" || entry.length > 240 || !SAFE_UI_ASSET.test(entry)) {
    invalid("UI 资源必须位于 ui/ 下且使用受支持的静态文件扩展名");
  }
  return entry;
}

export function validatePackagedImageV3(entry: unknown): string {
  const asset = validateUiAssetPathV3(entry);
  if (!/\.(?:png|jpg|jpeg|webp|gif)$/.test(asset)) invalid("V3 图标和截图必须是 ui/ 下的图片资源");
  return asset;
}

export function validatePackagedHtmlEntry(entry: unknown): string {
  if (typeof entry !== "string" || entry.length > 240 || !SAFE_PACKAGED_HTML.test(entry)) {
    invalid("应用入口必须是安装包内的相对 HTML 路径");
  }
  return entry;
}

export function parseAppPageDeclarationsV3(
  pluginId: string,
  pages: unknown,
  declaredPermissions: readonly string[],
): AppPageDeclarationV3[] {
  if (typeof pluginId !== "string" || pluginId.length > 150 || !PLUGIN_ID.test(pluginId)) invalid("插件 ID 不合法");
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > 16) invalid("应用页面数必须在 1 到 16 之间");
  const declared = new Set(declaredPermissions);
  const seen = new Set<string>();
  return pages.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("页面声明必须是对象");
    const obj = raw as Record<string, unknown>;
    if (Object.keys(obj).some((key) => !["id", "title", "entry", "platforms", "requiredPermissions"].includes(key))) {
      invalid("应用页面包含不支持的字段");
    }
    if (typeof obj.id !== "string" || !PAGE_ID.test(obj.id) || seen.has(obj.id)) invalid("页面 ID 无效或重复");
    seen.add(obj.id);
    if (typeof obj.title !== "string" || !obj.title.trim() || obj.title.length > 100) invalid("页面标题无效");
    const entry = validatePackagedHtmlEntry(obj.entry);
    if (!Array.isArray(obj.platforms) || obj.platforms.length === 0 || obj.platforms.length > 4 ||
      obj.platforms.some((p) => !PLATFORMS.has(p as AppPlatformV3)) ||
      new Set(obj.platforms).size !== obj.platforms.length) invalid("页面平台列表无效");
    const requested = obj.requiredPermissions === undefined ? [] : obj.requiredPermissions;
    if (!Array.isArray(requested) || requested.length > 32 ||
      requested.some((p) => typeof p !== "string" || !ALLOWED_PERMISSIONS.has(p) || !declared.has(p)) ||
      new Set(requested).size !== requested.length) invalid("页面请求了 Manifest 未声明或不支持的权限");
    return {
      id: obj.id,
      title: obj.title.trim(),
      entry,
      platforms: [...obj.platforms] as AppPlatformV3[],
      requiredPermissions: [...requested] as PluginPermission[],
    };
  });
}

export interface InstalledAppCandidateV3 {
  id: string;
  status: string;
  manifestJson: string;
}

export function buildAppRegistryV3(
  records: readonly InstalledAppCandidateV3[],
  platform: AppPlatformV3,
  enabled = getApplicationV3FeatureFlags().appPages,
): RegisteredAppPageV3[] {
  if (!enabled || !PLATFORMS.has(platform)) return [];
  const result: RegisteredAppPageV3[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (record.status !== "enabled") continue;
    try {
      const manifest = JSON.parse(record.manifestJson) as Record<string, unknown>;
      if (manifest.apiVersion !== APPLICATION_V3_API_VERSION || manifest.id !== record.id) continue;
      const contributes = manifest.contributes as Record<string, unknown> | undefined;
      const permissions = Array.isArray(manifest.permissions) ? manifest.permissions as string[] : [];
      const pages = parseAppPageDeclarationsV3(record.id, contributes?.appPages, permissions);
      for (const page of pages) {
        if (!page.platforms.includes(platform)) continue;
        const runtimeId = record.id + "/" + page.id;
        if (seen.has(runtimeId)) continue;
        seen.add(runtimeId);
        result.push({ ...page, pluginId: record.id, runtimeId, route: "/apps/" + encodeURIComponent(record.id) + "/" + page.id });
      }
    } catch {
      // Broken manifests cannot crash the main navigation. Report separately to diagnostics.
    }
  }
  return result;
}
