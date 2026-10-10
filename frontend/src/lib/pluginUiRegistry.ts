import type {
  PluginContributionRecord,
  PluginNavigationTarget,
  PluginUiActionContribution,
  PluginUiIcon,
} from "./pluginApi";

export type UiPlatform = "web" | "desktop" | "android" | "ios";

export interface RegisteredPluginUiAction extends PluginUiActionContribution {
  pluginId: string;
  runtimeId: string;
}

const ICONS = new Set<PluginUiIcon>(["home", "star", "files", "diary", "tasks", "mindmap", "ai", "shares", "settings"]);
const TARGETS = new Set<PluginNavigationTarget>(["all", "favorites", "files", "diary", "tasks", "mindmaps", "ai-chat", "shares", "settings"]);
let registered: RegisteredPluginUiAction[] = [];

function validComponent(value: unknown): value is PluginUiActionContribution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as PluginUiActionContribution;
  return /^[a-z][a-z0-9-]{0,63}$/.test(item.id)
    && item.kind === "action"
    && typeof item.label === "string"
    && item.label.length > 0
    && item.label.length <= 100
    && ICONS.has(item.icon)
    && Array.isArray(item.allowedSlots)
    && item.allowedSlots.length === 1
    && item.allowedSlots[0] === "floating-layer"
    && item.action?.type === "navigation.open"
    && TARGETS.has(item.action.target)
    && (!item.defaultPlacement || item.defaultPlacement.slot === "floating-layer");
}

export function replacePluginUiComponents(records: PluginContributionRecord[]): void {
  const next: RegisteredPluginUiAction[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (typeof record.pluginId !== "string" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(record.pluginId)) continue;
    for (const component of Array.isArray(record.uiComponents) ? record.uiComponents : []) {
      if (!validComponent(component)) continue;
      const runtimeId = `${record.pluginId}/${component.id}`;
      if (seen.has(runtimeId)) continue;
      seen.add(runtimeId);
      next.push({ ...component, pluginId: record.pluginId, runtimeId });
    }
  }
  registered = next;
}

export function listPluginUiComponents(platform: UiPlatform): RegisteredPluginUiAction[] {
  return registered.filter((component) => !component.uiPlatform || component.uiPlatform.includes(platform));
}

export function clearPluginUiComponents(): void {
  registered = [];
}

export function currentUiPlatform(): UiPlatform {
  const global = window as Window & { Capacitor?: { getPlatform?: () => string; platform?: string }; nowenDesktop?: { isDesktop?: boolean } };
  const capacitorPlatform = global.Capacitor?.getPlatform?.() || global.Capacitor?.platform;
  if (capacitorPlatform === "android" || capacitorPlatform === "ios") return capacitorPlatform;
  return global.nowenDesktop?.isDesktop ? "desktop" : "web";
}
