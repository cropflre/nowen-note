import { getOfflineQueueStorageKey } from "./offlineScope";
export type WidgetSize = "small" | "medium" | "large";
export interface WidgetPlacement { id: string; hidden: boolean; size: WidgetSize }
export interface DashboardLayouts { active: string; layouts: Array<{ name: string; items: WidgetPlacement[] }> }

/** Existing protections: at most 5 named layouts and 12 cards per layout. */
export const DASHBOARD_LIMITS = { layouts: 5, cards: 12, layoutName: 40, history: 20 } as const;

/**
 * Built-in cards live in a reserved namespace. V2/V3 plugin IDs always contain a "." (publisher
 * namespace), so "nowen-builtin" can never collide with a plugin widget runtime ID.
 */
export const BUILTIN_WIDGET_NAMESPACE = "nowen-builtin";
export type BuiltinWidgetKind = "quick-note" | "today-tasks" | "recent-notes" | "task-stats" | "diary-calendar" | "favorites";
export const BUILTIN_WIDGETS: ReadonlyArray<{ kind: BuiltinWidgetKind; id: string; defaultSize: WidgetSize }> = [
  { kind: "quick-note", id: "nowen-builtin/quick-note", defaultSize: "medium" },
  { kind: "today-tasks", id: "nowen-builtin/today-tasks", defaultSize: "small" },
  { kind: "recent-notes", id: "nowen-builtin/recent-notes", defaultSize: "small" },
  { kind: "task-stats", id: "nowen-builtin/task-stats", defaultSize: "small" },
  { kind: "diary-calendar", id: "nowen-builtin/diary-calendar", defaultSize: "small" },
  { kind: "favorites", id: "nowen-builtin/favorites", defaultSize: "small" },
];
const BUILTIN_BY_ID = new Map(BUILTIN_WIDGETS.map((widget) => [widget.id, widget]));

export function builtinWidgetKind(id: string): BuiltinWidgetKind | null {
  return BUILTIN_BY_ID.get(id)?.kind ?? null;
}

const PLACEMENT_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+\/[a-z][a-z0-9-]{0,63}$/;

export function dashboardStorageKey(workspace: string, mobile: boolean): string {
  return `${getOfflineQueueStorageKey()}:dashboard:v1:${encodeURIComponent(workspace)}:${mobile ? "mobile" : "desktop"}`;
}

/** Strictly validate an untrusted (stored or imported) layout document; null when anything is off. */
export function parseDashboardLayouts(value: unknown): DashboardLayouts | null {
  try {
    if (!value || typeof value !== "object" || !("layouts" in value) || !Array.isArray(value.layouts)
      || value.layouts.length < 1 || value.layouts.length > DASHBOARD_LIMITS.layouts) return null;
    const names = new Set<string>();
    const layouts = value.layouts.map((entry: unknown) => {
      if (!entry || typeof entry !== "object") throw new Error();
      const layout = entry as Record<string, unknown>;
      if (typeof layout.name !== "string" || !layout.name.trim() || layout.name.length > DASHBOARD_LIMITS.layoutName || names.has(layout.name)
        || !Array.isArray(layout.items) || layout.items.length > DASHBOARD_LIMITS.cards) throw new Error();
      names.add(layout.name);
      const ids = new Set<string>();
      const items: WidgetPlacement[] = layout.items.map((placement: unknown) => {
        if (!placement || typeof placement !== "object") throw new Error();
        const item = placement as Record<string, unknown>;
        if (typeof item.id !== "string" || !PLACEMENT_ID.test(item.id)
          || ids.has(item.id) || typeof item.size !== "string" || !["small", "medium", "large"].includes(item.size)
          || typeof item.hidden !== "boolean") throw new Error();
        ids.add(item.id);
        return { id: item.id, size: item.size as WidgetSize, hidden: item.hidden };
      });
      return { name: layout.name, items };
    });
    const active = "active" in value && typeof value.active === "string" && names.has(value.active) ? value.active : layouts[0].name;
    return { active, layouts };
  } catch { return null; }
}

export function loadDashboardLayouts(key: string, defaults: WidgetPlacement[]): DashboardLayouts {
  try {
    const parsed = parseDashboardLayouts(JSON.parse(localStorage.getItem(key) || "null"));
    if (parsed) return parsed;
  } catch { /* Invalid device preferences cannot break application startup. */ }
  return { active: "Default", layouts: [{ name: "Default", items: defaults.slice(0, DASHBOARD_LIMITS.cards).map(item => ({ ...item })) }] };
}
export function saveDashboardLayouts(key: string, layouts: DashboardLayouts): boolean {
  try { localStorage.setItem(key, JSON.stringify(layouts)); return true; } catch { return false; }
}
export function moveDashboardWidget(items: WidgetPlacement[], from: number, to: number): WidgetPlacement[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return items;
  const next = [...items]; next.splice(to, 0, next.splice(from, 1)[0]); return next;
}

/** Installed plugin widgets first (the user installed them on purpose), then built-in cards; capped at 12. */
export function defaultDashboardPlacements(pluginWidgets: ReadonlyArray<{ runtimeId: string; defaultSize: WidgetSize }>): WidgetPlacement[] {
  return [
    ...pluginWidgets.map((widget) => ({ id: widget.runtimeId, hidden: false, size: widget.defaultSize })),
    ...BUILTIN_WIDGETS.map((widget) => ({ id: widget.id, hidden: false, size: widget.defaultSize })),
  ].slice(0, DASHBOARD_LIMITS.cards);
}

export type LayoutNameError = "EMPTY" | "TOO_LONG" | "DUPLICATE";
export function layoutNameError(name: string, layouts: DashboardLayouts, current?: string): LayoutNameError | null {
  const trimmed = name.trim();
  if (!trimmed) return "EMPTY";
  if (trimmed.length > DASHBOARD_LIMITS.layoutName) return "TOO_LONG";
  if (layouts.layouts.some((layout) => layout.name === trimmed && layout.name !== current)) return "DUPLICATE";
  return null;
}

/** New empty layout that becomes active; null when the name is invalid or 5 layouts already exist. */
export function addDashboardLayout(layouts: DashboardLayouts, name: string): DashboardLayouts | null {
  if (layouts.layouts.length >= DASHBOARD_LIMITS.layouts || layoutNameError(name, layouts)) return null;
  const trimmed = name.trim();
  return { active: trimmed, layouts: [...layouts.layouts, { name: trimmed, items: [] }] };
}

export function renameDashboardLayout(layouts: DashboardLayouts, from: string, to: string): DashboardLayouts | null {
  if (!layouts.layouts.some((layout) => layout.name === from) || layoutNameError(to, layouts, from)) return null;
  const trimmed = to.trim();
  return {
    active: layouts.active === from ? trimmed : layouts.active,
    layouts: layouts.layouts.map((layout) => (layout.name === from ? { ...layout, name: trimmed } : layout)),
  };
}

/** The last remaining layout can never be deleted. */
export function deleteDashboardLayout(layouts: DashboardLayouts, name: string): DashboardLayouts | null {
  if (layouts.layouts.length <= 1 || !layouts.layouts.some((layout) => layout.name === name)) return null;
  const next = layouts.layouts.filter((layout) => layout.name !== name);
  return { active: layouts.active === name ? next[0].name : layouts.active, layouts: next };
}

export function replaceActiveItems(layouts: DashboardLayouts, items: WidgetPlacement[]): DashboardLayouts {
  return { ...layouts, layouts: layouts.layouts.map((layout) => (layout.name === layouts.active ? { ...layout, items } : layout)) };
}

export type AddCardError = "DUPLICATE" | "LIMIT" | "INVALID";
export function addCardError(items: readonly WidgetPlacement[], id: string): AddCardError | null {
  if (!PLACEMENT_ID.test(id)) return "INVALID";
  if (items.some((item) => item.id === id)) return "DUPLICATE";
  if (items.length >= DASHBOARD_LIMITS.cards) return "LIMIT";
  return null;
}

/** Bounded undo stack of previous layout documents (newest last). */
export function pushLayoutHistory(history: readonly DashboardLayouts[], snapshot: DashboardLayouts): DashboardLayouts[] {
  return [...history, snapshot].slice(-DASHBOARD_LIMITS.history);
}

export type DashboardCardResolution<W> =
  | { type: "builtin"; kind: BuiltinWidgetKind }
  | { type: "plugin"; widget: W }
  /** Plugin card whose plugin is disabled, uninstalled, unpermitted, or a built-in from a newer version. */
  | { type: "dormant"; reason: "PLUGIN_UNAVAILABLE" | "UNKNOWN_BUILTIN" };

export function resolveDashboardCard<W extends { runtimeId: string }>(placement: WidgetPlacement, pluginWidgets: ReadonlyMap<string, W>): DashboardCardResolution<W> {
  const kind = builtinWidgetKind(placement.id);
  if (kind) return { type: "builtin", kind };
  if (placement.id.startsWith(`${BUILTIN_WIDGET_NAMESPACE}/`)) return { type: "dormant", reason: "UNKNOWN_BUILTIN" };
  const widget = pluginWidgets.get(placement.id);
  return widget ? { type: "plugin", widget } : { type: "dormant", reason: "PLUGIN_UNAVAILABLE" };
}
