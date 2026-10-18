import { getOfflineQueueStorageKey } from "./offlineScope";
export type WidgetSize = "small" | "medium" | "large";
export interface WidgetPlacement { id: string; hidden: boolean; size: WidgetSize }
export interface DashboardLayouts { active: string; layouts: Array<{ name: string; items: WidgetPlacement[] }> }
export function dashboardStorageKey(workspace: string, mobile: boolean): string {
  return `${getOfflineQueueStorageKey()}:dashboard:v1:${encodeURIComponent(workspace)}:${mobile ? "mobile" : "desktop"}`;
}
export function loadDashboardLayouts(key: string, defaults: WidgetPlacement[]): DashboardLayouts {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    if (parsed && Array.isArray(parsed.layouts) && parsed.layouts.length >= 1 && parsed.layouts.length <= 5) {
      const names = new Set<string>();
      const layouts = parsed.layouts.map((layout: any) => {
        if (typeof layout.name !== "string" || !layout.name.trim() || layout.name.length > 40 || names.has(layout.name) || !Array.isArray(layout.items) || layout.items.length > 12) throw new Error();
        names.add(layout.name); const ids = new Set<string>();
        const items: WidgetPlacement[] = layout.items.map((item: any) => {
          if (typeof item.id !== "string" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+\/[a-z][a-z0-9-]{0,63}$/.test(item.id) || ids.has(item.id) || !["small", "medium", "large"].includes(item.size) || typeof item.hidden !== "boolean") throw new Error();
          ids.add(item.id); return { id: item.id, size: item.size, hidden: item.hidden };
        });
        return { name: layout.name, items };
      });
      return { active: names.has(parsed.active) ? parsed.active : layouts[0].name, layouts };
    }
  } catch { /* Invalid device preferences cannot break application startup. */ }
  return { active: "Default", layouts: [{ name: "Default", items: defaults.slice(0, 6).map(item => ({ ...item })) }] };
}
export function saveDashboardLayouts(key: string, layouts: DashboardLayouts): boolean {
  try { localStorage.setItem(key, JSON.stringify(layouts)); return true; } catch { return false; }
}
export function moveDashboardWidget(items: WidgetPlacement[], from: number, to: number): WidgetPlacement[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return items;
  const next = [...items]; next.splice(to, 0, next.splice(from, 1)[0]); return next;
}
