import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Sidebar from "../Sidebar";

const mocks = vi.hoisted(() => ({
  workspaceId: "personal",
  localMode: false,
  actions: { setNotebooks: vi.fn(), setTags: vi.fn(), setMobileSidebar: vi.fn() },
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: { tags: [], selectedTagIds: [], viewMode: "all" } }),
  useAppActions: () => mocks.actions,
}));
vi.mock("@/components/KnowledgeTreeCreateMenuRuntime", () => ({
  default: () => <div data-tree="recursive" />,
  FOCUS_KNOWLEDGE_TREE_EVENT: "test:focus-tree",
  KNOWLEDGE_TREE_CHANGED_EVENT: "test:tree-changed",
}));
vi.mock("@/components/MobileKnowledgeTreePanel", () => ({ default: () => <div data-tree="quick" /> }));
vi.mock("@/components/KnowledgeTreeDrawer", () => ({ OPEN_KNOWLEDGE_TREE_EVENT: "test:open-tree" }));
vi.mock("@/components/WorkspaceSwitcher", () => ({ default: () => <div data-workspace-switcher="" /> }));
vi.mock("@/components/TagColorPopover", () => ({ default: () => null }));
vi.mock("@/components/NoteTemplatePickerDialog", () => ({
  default: ({ open, mode, onCreate, onClose }: {
    open: boolean; mode?: string; onCreate?: unknown; onClose: () => void;
  }) => open ? (
    <div role="dialog" data-mode={mode} data-can-create={Boolean(onCreate)}>
      <button type="button" onClick={onClose}>Close templates</button>
    </div>
  ) : null,
}));
vi.mock("@/hooks/useRailMode", () => ({ useRailMode: () => ["icon", vi.fn()] }));
vi.mock("@/hooks/useMobileRailHidden", () => ({ useMobileRailHidden: () => [false, vi.fn()] }));
vi.mock("@/hooks/useMobileSidebarControlsCollapsed", () => ({ useMobileSidebarControlsCollapsed: () => [true, vi.fn()] }));
vi.mock("@/hooks/useSidebarTextStyle", () => ({ useSidebarTextStyle: () => ["classic"] }));
vi.mock("@/hooks/useSiteSettings", () => ({ useSiteSettings: () => ({ siteConfig: {} }) }));
vi.mock("@/hooks/useUserPreferences", () => ({ useUserPreferences: () => ({ prefs: { hiddenNavigationModules: [] } }) }));
vi.mock("@/lib/knowledgeTreeScrollbarBridge", () => ({ refreshKnowledgeTreeScrollbars: vi.fn() }));
vi.mock("@/lib/mobileLocalMode", () => ({ isMobileLocalMode: () => mocks.localMode }));
vi.mock("@/lib/api", () => ({
  getCurrentWorkspace: () => mocks.workspaceId,
  api: { getNotebooks: async () => [], getTags: async () => [] },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("sidebar template management", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("nowen-tags-expanded", "false");
    mocks.workspaceId = "personal";
    mocks.localMode = false;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it.each(["desktop", "mobile"] as const)("opens and closes template management from the %s sidebar", async (variant) => {
    mocks.workspaceId = "smt-workspace";
    await act(async () => root.render(<Sidebar variant={variant} />));
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent === "sidebar.templateManagement");
    expect(button).toBeDefined();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button!.click());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("data-mode")).toBe("manage");
    expect(dialog.getAttribute("data-can-create")).toBe("false");
    await act(async () => dialog.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("offers personal templates and keeps the server-only library out of native device mode", async () => {
    await act(async () => root.render(<Sidebar />));
    expect(host.textContent).toContain("sidebar.templateManagement");
    mocks.localMode = true;
    await act(async () => root.render(<Sidebar />));
    expect(host.textContent).not.toContain("sidebar.templateManagement");
  });
});
