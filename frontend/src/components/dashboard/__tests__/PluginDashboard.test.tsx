import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspace: { current: "personal" },
  push: vi.fn(), toastInfo: vi.fn(), confirm: vi.fn(), prompt: vi.fn(),
  actions: { setViewMode: vi.fn(), setMobileView: vi.fn(), refreshNotes: vi.fn(), refreshNotebooks: vi.fn() },
  state: { notebooks: [{ id: "nb-personal", name: "Inbox", workspaceId: null }, { id: "nb-second", name: "Second", workspaceId: null }, { id: "nb-team", name: "Team", workspaceId: "ws-1" }], selectedNotebookId: null as string | null },
  api: {
    getNotes: vi.fn(), createNote: vi.fn(), getTasks: vi.fn(), toggleTask: vi.fn(), getTaskStats: vi.fn(), getDiaryTimeline: vi.fn(),
  },
  pluginApi: { features: vi.fn(), widgets: vi.fn(), widgetEvents: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api: mocks.api, getCurrentWorkspace: () => mocks.workspace.current }));
vi.mock("@/lib/pluginApi", () => ({ pluginApi: mocks.pluginApi, PLUGIN_CONTRIBUTIONS_CHANGED_EVENT: "nowen:plugin-contributions-changed" }));
vi.mock("@/lib/appPathNavigation", () => ({ pushAppPathState: mocks.push }));
vi.mock("@/lib/toast", () => ({ toast: { info: mocks.toastInfo, success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/components/ui/confirm", () => ({ confirm: mocks.confirm, prompt: mocks.prompt }));
vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: mocks.state }), useAppActions: () => mocks.actions }));
vi.mock("@/lib/pluginUiRegistry", () => ({ currentUiPlatform: () => "web" }));
vi.mock("../../PluginApps", () => ({ PluginAppFrame: () => <div data-app-frame /> }));
vi.mock("react-i18next", () => ({
  // lib/dateTime pulls in the i18n bootstrap, which registers this plugin.
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string, options?: Record<string, unknown>) => (options && "message" in options ? `${key}|${String(options.message)}` : key) }),
}));
import PluginDashboard from "../../PluginDashboard";
import { dashboardStorageKey } from "@/lib/pluginDashboard";

let root: Root, host: HTMLDivElement;
const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const button = (label: string, scope: ParentNode = host) => [...scope.querySelectorAll("button")].find((item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label) as HTMLButtonElement | undefined;
const card = (id: string) => host.querySelector(`[data-widget-id="${id}"]`);
const render = async () => { await act(async () => root.render(<PluginDashboard />)); await flush(); };
const type = async (element: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); localStorage.clear(); mocks.workspace.current = "personal";
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  mocks.pluginApi.features.mockResolvedValue({ applicationV3: { dashboardWidgets: false } });
  mocks.pluginApi.widgets.mockResolvedValue([]);
  mocks.pluginApi.widgetEvents.mockReturnValue(new Promise(() => undefined));
  mocks.api.getNotes.mockResolvedValue([
    { id: "n-old", title: "Old", updatedAt: "2026-01-01 08:00:00" },
    { id: "n-new", title: "New", updatedAt: "2026-11-09 08:00:00" },
  ]);
  mocks.api.getTasks.mockResolvedValue([{ id: "t1", title: "Ship it", isCompleted: 0 }, { id: "t-archived", title: "Gone", isCompleted: 0, archivedAt: "2026-11-01" }]);
  mocks.api.toggleTask.mockResolvedValue({ task: { id: "t1", isCompleted: 1 } });
  mocks.api.getTaskStats.mockResolvedValue({ total: 5, completed: 1, pending: 4, today: 2, overdue: 1, week: 3, completedToday: 1 });
  mocks.api.getDiaryTimeline.mockResolvedValue({ items: [], hasMore: false, nextCursor: null });
  mocks.api.createNote.mockResolvedValue({ id: "created" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("workbench", () => {
  it("shows built-in cards with real data, newest notes first, and no archived tasks", async () => {
    await render();
    for (const id of ["quick-note", "today-tasks", "recent-notes", "task-stats", "diary-calendar", "favorites"]) expect(card(`nowen-builtin/${id}`)).not.toBeNull();
    expect(mocks.api.getNotes).toHaveBeenCalledWith({ sortBy: "recent", limit: "5" });
    expect(mocks.api.getNotes).toHaveBeenCalledWith({ isFavorite: "1", sortBy: "recent", limit: "5" });
    const recent = card("nowen-builtin/recent-notes")!;
    expect([...recent.querySelectorAll("li")].map((item) => item.textContent?.slice(0, 3))).toEqual(["New", "Old"]);
    expect(card("nowen-builtin/today-tasks")!.textContent).toContain("Ship it");
    expect(card("nowen-builtin/today-tasks")!.textContent).not.toContain("Gone");
    expect(card("nowen-builtin/task-stats")!.textContent).toContain("4");
  });

  it("saves quick notes through the regular note API and keeps the draft on failure", async () => {
    await render();
    const textarea = card("nowen-builtin/quick-note")!.querySelector("textarea")!;
    mocks.api.createNote.mockRejectedValueOnce(new Error("forbidden"));
    await type(textarea, "# Idea\nMore detail");
    await act(async () => button("extensionCenter.workbench.quickNoteSave")!.click()); await flush();
    expect(textarea.value).toBe("# Idea\nMore detail");
    expect(host.textContent).toContain("extensionCenter.workbench.quickNoteFailed|forbidden");
    // Only notebooks of the current space are offered; the user can pick the target.
    const select = card("nowen-builtin/quick-note")!.querySelector("select")!;
    expect([...select.options].map((option) => option.value)).toEqual(["nb-personal", "nb-second"]);
    await act(async () => { select.value = "nb-second"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => button("extensionCenter.workbench.quickNoteSave")!.click()); await flush();
    expect(mocks.api.createNote).toHaveBeenLastCalledWith({ notebookId: "nb-second", title: "Idea", content: "# Idea\nMore detail", contentText: "# Idea\nMore detail", contentFormat: "markdown" });
    expect(textarea.value).toBe("");
    expect(mocks.actions.refreshNotes).toHaveBeenCalled();
  });

  it("toggles tasks with the task-center API", async () => {
    await render();
    await act(async () => (card("nowen-builtin/today-tasks")!.querySelector('input[type="checkbox"]') as HTMLInputElement).click()); await flush();
    expect(mocks.api.toggleTask).toHaveBeenCalledWith("t1");
  });

  it("keeps a dormant placeholder for a missing plugin card instead of deleting it", async () => {
    const key = dashboardStorageKey("personal", false);
    localStorage.setItem(key, JSON.stringify({ active: "Default", layouts: [{ name: "Default", items: [{ id: "acme.gone/card", hidden: false, size: "small" }, { id: "nowen-builtin/task-stats", hidden: false, size: "small" }] }] }));
    await render();
    expect(host.querySelector('[data-widget-id="acme.gone/card"]')).toBeNull();
    const dormant = host.querySelector('[data-dormant-widget-id="acme.gone/card"]')!;
    expect(dormant.textContent).toContain("extensionCenter.workbench.dormantPlugin");
    await act(async () => button("extensionCenter.workbench.dormantManage", dormant)!.click());
    expect(mocks.push).toHaveBeenCalledWith("/apps/manage");
    expect(JSON.parse(localStorage.getItem(key)!).layouts[0].items).toHaveLength(2);
  });

  it("undoes the last layout change and warns when the layout cannot be saved", async () => {
    await render();
    await act(async () => button("pluginApps.editLayout")!.click());
    await act(async () => button("pluginApps.hideCard", card("nowen-builtin/favorites")!)!.click());
    expect(card("nowen-builtin/favorites")!.textContent).toContain("extensionCenter.workbench.hiddenBadge");
    await act(async () => button("extensionCenter.workbench.undo")!.click());
    expect(card("nowen-builtin/favorites")!.textContent).not.toContain("extensionCenter.workbench.hiddenBadge");

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceeded"); });
    await act(async () => button("pluginApps.hideCard", card("nowen-builtin/favorites")!)!.click());
    expect(host.textContent).toContain("extensionCenter.workbench.unsaved");
    setItem.mockRestore();
    await act(async () => button("extensionCenter.workbench.retrySave")!.click());
    expect(host.textContent).not.toContain("extensionCenter.workbench.unsaved");
  });

  it("adopts a layout saved by another tab", async () => {
    await render();
    const key = dashboardStorageKey("personal", false);
    const next = { active: "Default", layouts: [{ name: "Default", items: [{ id: "nowen-builtin/task-stats", hidden: false, size: "large" }] }] };
    await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key, newValue: JSON.stringify(next) })); });
    await flush();
    expect(host.querySelectorAll("[data-widget-id]")).toHaveLength(1);
    expect(mocks.toastInfo).toHaveBeenCalledWith("extensionCenter.workbench.syncedFromOtherTab");
  });

  it("switches to the new workspace's own layout and data", async () => {
    await render();
    await act(async () => button("pluginApps.editLayout")!.click());
    await act(async () => button("pluginApps.removeCard", card("nowen-builtin/favorites")!)!.click());
    expect(card("nowen-builtin/favorites")).toBeNull();
    mocks.workspace.current = "ws-1";
    mocks.api.getNotes.mockClear();
    await act(async () => { window.dispatchEvent(new Event("nowen:workspace-changed")); });
    await flush();
    expect(card("nowen-builtin/favorites")).not.toBeNull();
    expect(mocks.api.getNotes).toHaveBeenCalled();
    expect(localStorage.getItem(dashboardStorageKey("ws-1", false))).toBeNull();
  });

  it("seeds a new workspace's default layout from that workspace's widgets only", async () => {
    const widget = (pluginId: string) => ({ id: "card", title: `${pluginId} card`, type: "shortcut", pageId: "home", defaultSize: "small", pluginId, runtimeId: `${pluginId}/card`, page: { pluginId, id: "home", title: "Home", route: `/apps/${pluginId}/home`, runtimeId: `${pluginId}/home` }, preview: null });
    mocks.pluginApi.features.mockResolvedValue({ applicationV3: { dashboardWidgets: true } });
    mocks.pluginApi.widgets.mockResolvedValue([widget("acme.one")]);
    await render();
    expect(card("acme.one/card")).not.toBeNull();

    let release!: (value: unknown) => void;
    mocks.pluginApi.widgets.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    mocks.workspace.current = "ws-1";
    await act(async () => { window.dispatchEvent(new Event("nowen:workspace-changed")); });
    await flush();
    expect(card("acme.one/card")).toBeNull();
    await act(async () => release([widget("acme.two")])); await flush();
    expect(card("acme.two/card")).not.toBeNull();
    expect(host.querySelector('[data-dormant-widget-id="acme.one/card"]')).toBeNull();
  });
});
