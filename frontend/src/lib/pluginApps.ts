import { getOfflineQueueStorageKey } from "./offlineScope";

export function parsePluginAppPath(path: string): { matched: boolean; dashboard?: boolean; pluginId?: string; pageId?: string } {
  if (path === "/apps") return { matched: true };
  if (path === "/apps/dashboard") return { matched: true, dashboard: true };
  const match = /^\/apps\/([a-z0-9]+(?:[.-][a-z0-9]+)+)\/([a-z][a-z0-9-]{0,63})$/.exec(path);
  return match && match[1].length <= 150 ? { matched: true, pluginId: match[1], pageId: match[2] } : { matched: false };
}
function pinsKey(): string { return `${getOfflineQueueStorageKey()}:plugin-app-pins:v1`; }
export function loadPluginAppPins(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(pinsKey()) || "[]");
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length <= 215))].slice(0, 100) : [];
  } catch { return []; }
}
export function savePluginAppPins(pins: string[]): void {
  try { localStorage.setItem(pinsKey(), JSON.stringify(pins.slice(0, 100))); } catch { /* Device-local preference is optional. */ }
  window.dispatchEvent(new Event("nowen:plugin-app-pins-changed"));
}
