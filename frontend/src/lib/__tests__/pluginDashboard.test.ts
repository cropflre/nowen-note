import { describe, it, expect, afterEach } from "vitest";
import {
  addCardError, addDashboardLayout, BUILTIN_WIDGETS, builtinWidgetKind, dashboardStorageKey, defaultDashboardPlacements, deleteDashboardLayout,
  layoutNameError, loadDashboardLayouts, moveDashboardWidget, parseDashboardLayouts, pushLayoutHistory, renameDashboardLayout, replaceActiveItems,
  resolveDashboardCard, saveDashboardLayouts, type DashboardLayouts,
} from "../pluginDashboard";
import { parsePluginAppPath } from "../pluginApps";
import { inferBrowserServerBaseUrl } from "../serverUrl";
afterEach(() => localStorage.clear());
describe("device-scoped dashboard layouts", () => {
  const defaults = [{ id: "nowenlab.demo/count", hidden: false, size: "small" as const }];
  it("separates workspace, account and mobile layouts", () => {
    const key = dashboardStorageKey("personal", false), layout = loadDashboardLayouts(key, defaults);
    layout.layouts[0].items[0].hidden = true; expect(saveDashboardLayouts(key, layout)).toBe(true);
    expect(loadDashboardLayouts(key, defaults).layouts[0].items[0].hidden).toBe(true);
    expect(dashboardStorageKey("other-space", false)).not.toBe(key); expect(dashboardStorageKey("personal", true)).not.toBe(key);
    localStorage.setItem("nowen-token", `x.${btoa(JSON.stringify({ userId: "other" }))}.x`); expect(dashboardStorageKey("personal", false)).not.toBe(key);
  });
  it("rejects corrupt and duplicate placements while preserving removed or disabled declarations in valid layouts", () => {
    const key = dashboardStorageKey("personal", false);
    const saved = { active: "Writing", layouts: [{ name: "Writing", items: [{ id: "nowenlab.disabled/app", hidden: true, size: "large" }] }] };
    localStorage.setItem(key, JSON.stringify(saved)); expect(loadDashboardLayouts(key, defaults)).toEqual(saved);
    saved.layouts[0].items.push(saved.layouts[0].items[0]); localStorage.setItem(key, JSON.stringify(saved));
    expect(loadDashboardLayouts(key, defaults).active).toBe("Default");
  });
  it("moves only valid positions without changing hidden state or sizes", () => {
    const items = [...defaults, { id: "nowenlab.demo/list", hidden: true, size: "large" as const }];
    expect(moveDashboardWidget(items, 1, 0)).toEqual([items[1], items[0]]); expect(moveDashboardWidget(items, 0, -1)).toBe(items);
  });
  it("recognizes the dashboard route under a reverse proxy", () => {
    expect(parsePluginAppPath("/apps/dashboard")).toEqual({ matched: true, dashboard: true });
    expect(inferBrowserServerBaseUrl({ protocol: "https:", origin: "https://notes.example", pathname: "/nowen/apps/dashboard" })).toBe("https://notes.example/nowen");
  });
});

describe("dashboard layout operations", () => {
  const base = (): DashboardLayouts => ({ active: "Default", layouts: [{ name: "Default", items: [{ id: "nowen-builtin/quick-note", hidden: false, size: "medium" }] }] });

  it("puts installed plugin widgets before built-in cards and caps defaults at 12", () => {
    const plugins = Array.from({ length: 8 }, (_, index) => ({ runtimeId: `acme.demo/w${index}`, defaultSize: "small" as const }));
    const defaults = defaultDashboardPlacements(plugins);
    expect(defaults).toHaveLength(12);
    expect(defaults[0].id).toBe("acme.demo/w0");
    expect(defaults.slice(8).map((item) => item.id)).toEqual(BUILTIN_WIDGETS.slice(0, 4).map((item) => item.id));
    expect(defaultDashboardPlacements([]).map((item) => item.id)).toEqual(BUILTIN_WIDGETS.map((item) => item.id));
    // Defaults beyond the first six survive the loader (it used to keep only six).
    expect(loadDashboardLayouts(dashboardStorageKey("personal", false), defaults).layouts[0].items).toHaveLength(12);
  });

  it("validates names, keeps five layouts at most and never deletes the last one", () => {
    let layouts = base();
    expect(layoutNameError("  ", layouts)).toBe("EMPTY");
    expect(layoutNameError("x".repeat(41), layouts)).toBe("TOO_LONG");
    expect(layoutNameError("Default", layouts)).toBe("DUPLICATE");
    expect(layoutNameError("Default", layouts, "Default")).toBeNull();
    for (const name of ["A", "B", "C", "D"]) layouts = addDashboardLayout(layouts, ` ${name} `)!;
    expect(layouts.layouts.map((layout) => layout.name)).toEqual(["Default", "A", "B", "C", "D"]);
    expect(layouts.active).toBe("D");
    expect(addDashboardLayout(layouts, "E")).toBeNull();
    const renamed = renameDashboardLayout(layouts, "D", "Focus")!;
    expect([renamed.active, renamed.layouts[4].name]).toEqual(["Focus", "Focus"]);
    expect(renameDashboardLayout(layouts, "D", "A")).toBeNull();
    expect(renameDashboardLayout(layouts, "missing", "Z")).toBeNull();
    const deleted = deleteDashboardLayout(renamed, "Focus")!;
    expect([deleted.active, deleted.layouts.length]).toEqual(["Default", 4]);
    expect(deleteDashboardLayout(base(), "Default")).toBeNull();
  });

  it("refuses duplicate, invalid or thirteenth cards and edits only the active layout", () => {
    const layouts = { active: "B", layouts: [{ name: "A", items: [] }, { name: "B", items: [{ id: "nowen-builtin/favorites", hidden: false, size: "small" as const }] }] };
    expect(addCardError(layouts.layouts[1].items, "nowen-builtin/favorites")).toBe("DUPLICATE");
    expect(addCardError([], "../etc/passwd")).toBe("INVALID");
    const full = Array.from({ length: 12 }, (_, index) => ({ id: `acme.demo/w${index}`, hidden: false, size: "small" as const }));
    expect(addCardError(full, "acme.demo/extra")).toBe("LIMIT");
    expect(addCardError([], "acme.demo/extra")).toBeNull();
    const next = replaceActiveItems(layouts, []);
    expect(next.layouts[0]).toBe(layouts.layouts[0]);
    expect(next.layouts[1].items).toEqual([]);
  });

  it("keeps a bounded undo history", () => {
    let history: DashboardLayouts[] = [];
    for (let index = 0; index < 25; index += 1) history = pushLayoutHistory(history, { ...base(), active: `v${index}` });
    expect(history).toHaveLength(20);
    expect(history[0].active).toBe("v5");
    expect(history[19].active).toBe("v24");
  });

  it("resolves built-in, plugin and dormant cards without inventing data", () => {
    const widgets = new Map([["acme.demo/count", { runtimeId: "acme.demo/count", title: "Count" }]]);
    expect(resolveDashboardCard({ id: "nowen-builtin/today-tasks", hidden: false, size: "small" }, widgets)).toEqual({ type: "builtin", kind: "today-tasks" });
    expect(resolveDashboardCard({ id: "acme.demo/count", hidden: false, size: "small" }, widgets)).toEqual({ type: "plugin", widget: widgets.get("acme.demo/count") });
    expect(resolveDashboardCard({ id: "acme.gone/list", hidden: false, size: "small" }, widgets)).toEqual({ type: "dormant", reason: "PLUGIN_UNAVAILABLE" });
    expect(resolveDashboardCard({ id: "nowen-builtin/future-card", hidden: false, size: "small" }, widgets)).toEqual({ type: "dormant", reason: "UNKNOWN_BUILTIN" });
    expect(builtinWidgetKind("acme.demo/count")).toBeNull();
  });

  it("parses untrusted layout documents with the same rules as the loader", () => {
    expect(parseDashboardLayouts(base())).toEqual(base());
    expect(parseDashboardLayouts({ active: "x", layouts: [] })).toBeNull();
    expect(parseDashboardLayouts({ active: "Default", layouts: [{ name: "Default", items: [{ id: "nowen-builtin/quick-note", hidden: "no", size: "small" }] }] })).toBeNull();
    expect(parseDashboardLayouts("not json")).toBeNull();
  });
});
