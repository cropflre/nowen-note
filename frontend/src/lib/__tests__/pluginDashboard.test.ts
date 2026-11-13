import { describe, it, expect, afterEach } from "vitest";
import { dashboardStorageKey, loadDashboardLayouts, saveDashboardLayouts, moveDashboardWidget } from "../pluginDashboard";
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
