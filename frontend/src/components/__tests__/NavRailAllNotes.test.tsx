import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_PREFERENCES } from "@/lib/userPreferenceAccountCache";
import NavRail from "../NavRail";
import type { AppInfo } from '@/lib/desktopBridge';
import { clearDesktopLocalAuth } from '@/lib/desktopBridge';
import { broadcastLogout } from '@/lib/api';

const mock = vi.hoisted(() => ({
  desktop:false,serverUrl:'',appInfo:null as AppInfo|null,
  state: { viewMode: "tasks", selectedNotebookId: null as string | null, selectedTagIds: [] as string[], searchQuery: "", noteListCollapsed: true, sidebarCollapsed: false },
  actions: {
    setViewMode: vi.fn(), setSelectedNotebook: vi.fn(), clearSelectedTags: vi.fn(),
    setSearchQuery: vi.fn(), setMobileView: vi.fn(), setMobileSidebar: vi.fn(),
    toggleNoteListCollapsed: vi.fn(), setEditorFullscreen: vi.fn(),
  },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: mock.state }), useAppActions: () => mock.actions }));
vi.mock("@/hooks/useUserPreferences", () => ({ useUserPreferences: () => ({ prefs: DEFAULT_USER_PREFERENCES }) }));
vi.mock("@/hooks/useRailMode", () => ({ useRailMode: () => ["label"] }));
vi.mock("@/hooks/useSidebarTextStyle", () => ({ useSidebarTextStyle: () => ["classic"] }));
vi.mock("@/hooks/useMobileRailHidden", () => ({ useMobileRailHidden: () => [false, vi.fn()] }));
vi.mock("@/lib/api", () => ({ api: {}, getCurrentWorkspace: () => "personal", getServerUrl: () => mock.serverUrl, broadcastLogout: vi.fn(async()=>{}), clearServerUrl: vi.fn() }));
vi.mock("@/lib/desktopBridge", () => ({ isDesktop: () => mock.desktop, getAppInfo: vi.fn(async()=>mock.appInfo), getDiagnosticsInfo: vi.fn(async()=>null), clearDesktopLocalAuth: vi.fn(async()=>({ok:true})), switchDesktopToFull: vi.fn() }));
vi.mock("@/lib/offlineQueue", () => ({ clearQueue: vi.fn(), clearLocalIdMap: vi.fn(), getQueueLength: () => 0 }));
vi.mock("@/lib/accountLoginHistory", () => ({ isAccountLoginHistorySupported: () => false }));
vi.mock("@/components/AccountLoginHistory", () => ({ AccountLoginHistoryDialog: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); window.history.replaceState({}, "", "/");
  mock.desktop=false;mock.serverUrl='';mock.appInfo=null;
  Object.assign(mock.state, { viewMode: "tasks", selectedNotebookId: null, selectedTagIds: [], searchQuery: "", noteListCollapsed: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function render(variant: "desktop" | "mobile" = "desktop") { await act(async () => root.render(<NavRail variant={variant} />)); }
function entry() { return host.querySelector<HTMLButtonElement>('[aria-label="sidebar.allNotes"]')!; }

describe("All Notes primary navigation", () => {
  it('DCC-006: migrated desktop logout clears local auto-login before returning to account login', async () => {
    mock.desktop=true;mock.serverUrl='http://127.0.0.1:4555';
    mock.appInfo={version:'1.5.3',name:'Nowen Note',platform:'darwin',arch:'arm64',mode:'lite',runtime:'local',localServerUrl:mock.serverUrl,localMigrationComplete:true};
    await render();
    expect(host.querySelector('[aria-label="sidebar.switchToLocal"]')).toBeNull();
    const logout=host.querySelector<HTMLButtonElement>('[aria-label="sidebar.logout"]');
    expect(logout).not.toBeNull();
    await act(async()=>logout!.click());
    expect(clearDesktopLocalAuth).toHaveBeenCalledOnce();
    expect(localStorage.getItem('nowen-prefer-cloud')).toBe('1');
    expect(broadcastLogout).toHaveBeenCalledWith('desktop_logout_session');
  });
  it("is a labeled fixed entry before favorites", async () => {
    await render();
    expect(entry()).not.toBeNull();
    expect(entry().textContent).toBe("sidebar.allNotes");
    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.indexOf(entry())).toBeLessThan(buttons.findIndex(button => button.getAttribute("aria-label") === "sidebar.favorites"));
  });

  it.each(["tasks", "files", "ai-chat", "notebook", "search"])("returns from %s with filters cleared and the list expanded", async mode => {
    Object.assign(mock.state, { viewMode: mode, selectedNotebookId: "folder-1", selectedTagIds: ["tag-1"], searchQuery: "keyword" });
    localStorage.setItem("nowen-note-workspace-layout", "standard");
    await render(); expect(entry()).not.toBeNull();
    act(() => entry().click());
    expect(mock.actions.setViewMode).toHaveBeenCalledWith("all");
    expect(mock.actions.setSelectedNotebook).toHaveBeenCalledWith(null);
    expect(mock.actions.clearSelectedTags).toHaveBeenCalledOnce();
    expect(mock.actions.setSearchQuery).toHaveBeenCalledWith("");
    expect(mock.actions.toggleNoteListCollapsed).toHaveBeenCalledOnce();
    expect(localStorage.getItem("nowen-note-workspace-layout")).toBe("standard");
  });

  it("only marks an unfiltered all-notes view as current", async () => {
    mock.state.viewMode = "all";
    await render(); expect(entry()?.getAttribute("aria-current")).toBe("page");
    for (const patch of [{ selectedNotebookId: "folder-1" }, { selectedTagIds: ["tag-1"] }, { searchQuery: "keyword" }]) {
      Object.assign(mock.state, { selectedNotebookId: null, selectedTagIds: [], searchQuery: "" }, patch);
      await render(); expect(entry()?.hasAttribute("aria-current")).toBe(false);
    }
  });

  it("opens the mobile list and closes the drawer without changing desktop layout", async () => {
    localStorage.setItem("nowen-note-workspace-layout", "standard");
    await render("mobile"); expect(entry()).not.toBeNull();
    act(() => entry().click());
    expect(mock.actions.setMobileView).toHaveBeenCalledWith("list");
    expect(mock.actions.setMobileSidebar).toHaveBeenCalledWith(false);
    expect(mock.actions.toggleNoteListCollapsed).not.toHaveBeenCalled();
    expect(localStorage.getItem("nowen-note-workspace-layout")).toBe("standard");
  });
});
