import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import {
  loadMobileLiteMode,
  MOBILE_LITE_MEDIA_QUERY,
  MOBILE_LITE_MODE_STORAGE_KEY,
  resolveLiteQuickCreateTarget,
  saveMobileLiteMode,
} from "@/lib/mobileLiteMode";
import { consumeMobileBack } from "@/lib/mobileBackNavigation";
import { useMobileLiteMode } from "@/hooks/useMobileLiteMode";
import MobileLiteBottomBar from "@/components/mobileLite/MobileLiteBottomBar";
import MobileLiteMoreSheet from "@/components/mobileLite/MobileLiteMoreSheet";
import { DEFAULT_USER_PREFERENCES } from "@/lib/userPreferenceAccountCache";

const appMock = vi.hoisted(() => ({
  viewMode: "all" as const,
  setViewMode: vi.fn(),
  setSelectedNotebook: vi.fn(),
  setMobileView: vi.fn(),
  setMobileSidebar: vi.fn(),
}));

const prefsMock = vi.hoisted(() => ({
  hiddenNavigationModules: [] as string[],
}));

const envMock = vi.hoisted(() => ({
  aiAvailable: true,
  localMode: false,
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: { viewMode: appMock.viewMode } }),
  useAppActions: () => ({
    setViewMode: appMock.setViewMode,
    setSelectedNotebook: appMock.setSelectedNotebook,
    setMobileView: appMock.setMobileView,
    setMobileSidebar: appMock.setMobileSidebar,
  }),
}));

vi.mock("@/hooks/useUserPreferences", () => ({
  useUserPreferences: () => ({
    prefs: {
      ...DEFAULT_USER_PREFERENCES,
      hiddenNavigationModules: prefsMock.hiddenNavigationModules,
    },
  }),
}));

vi.mock("@/lib/aiConnection", () => ({
  useAIConnectionAvailable: () => envMock.aiAvailable,
}));

vi.mock("@/lib/mobileLocalMode", () => ({
  isMobileLocalMode: () => envMock.localMode,
  requestMobileAccountLogin: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getWorkspaceFeatures: vi.fn().mockResolvedValue(null),
  },
  getCurrentWorkspace: () => "personal",
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let mediaListeners: Array<() => void> = [];
let mockIsMobile = true;

function stubViewport(mobile: boolean) {
  mockIsMobile = mobile;
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return mockIsMobile && query === MOBILE_LITE_MEDIA_QUERY;
    },
    media: query,
    addEventListener: (_event: string, cb: () => void) => {
      mediaListeners.push(cb);
    },
    removeEventListener: (_event: string, cb: () => void) => {
      mediaListeners = mediaListeners.filter((item) => item !== cb);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
}

function renderNode(node: React.ReactNode) {
  act(() => {
    root.render(node);
  });
}

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

beforeEach(() => {
  localStorage.clear();
  mediaListeners = [];
  envMock.aiAvailable = true;
  envMock.localMode = false;
  prefsMock.hiddenNavigationModules = [];
  appMock.setViewMode.mockClear();
  appMock.setSelectedNotebook.mockClear();
  appMock.setMobileView.mockClear();
  appMock.setMobileSidebar.mockClear();
  stubViewport(true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MobileLiteMode persistence and viewport guard", () => {
  it("defaults to false and persists to localStorage", () => {
    expect(loadMobileLiteMode()).toBe(false);
    saveMobileLiteMode(true);
    expect(localStorage.getItem(MOBILE_LITE_MODE_STORAGE_KEY)).toBe("true");
    expect(loadMobileLiteMode()).toBe(true);
    saveMobileLiteMode(false);
    expect(loadMobileLiteMode()).toBe(false);
  });

  it("stays inactive on desktop viewports even when enabled is true", () => {
    saveMobileLiteMode(true);
    stubViewport(false);

    let snapshot = { enabled: false, active: true, isMobileViewport: true };
    function Probe() {
      const state = useMobileLiteMode();
      snapshot = {
        enabled: state.enabled,
        active: state.active,
        isMobileViewport: state.isMobileViewport,
      };
      return null;
    }

    renderNode(<Probe />);
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.isMobileViewport).toBe(false);
    expect(snapshot.active).toBe(false);

    // 切回手机视口后立即激活
    act(() => {
      mockIsMobile = true;
      mediaListeners.forEach((cb) => cb());
    });
    expect(snapshot.active).toBe(true);
  });
});

describe("resolveLiteQuickCreateTarget", () => {
  it("uses selected unlocked notebook first, then falls back to first unlocked notebook", () => {
    const notebooks = [
      { id: "nb-1", isPasswordProtected: 0 },
      { id: "nb-2", isPasswordProtected: 0 },
    ];
    expect(resolveLiteQuickCreateTarget({
      selectedNotebookId: "nb-2",
      notebooks,
      isLocalMode: false,
    })).toEqual({ kind: "notebook", notebookId: "nb-2" });

    expect(resolveLiteQuickCreateTarget({
      selectedNotebookId: null,
      notebooks,
      isLocalMode: false,
    })).toEqual({ kind: "notebook", notebookId: "nb-1" });
  });

  it("respects locked folders and never bypasses password protection", () => {
    const notebooks = [
      { id: "nb-locked", isPasswordProtected: 1 },
      { id: "nb-open", isPasswordProtected: 0 },
    ];
    expect(resolveLiteQuickCreateTarget({
      selectedNotebookId: "nb-locked",
      notebooks,
      lockedNotebookIds: new Set(["nb-locked"]),
      isLocalMode: false,
    })).toEqual({ kind: "locked", notebookId: "nb-locked" });

    // 未选具体目录时自动跳过锁定目录，落到未锁定目录
    expect(resolveLiteQuickCreateTarget({
      selectedNotebookId: null,
      notebooks,
      lockedNotebookIds: new Set(["nb-locked"]),
      isLocalMode: false,
    })).toEqual({ kind: "notebook", notebookId: "nb-open" });
  });

  it("handles empty workspace differently for local vs cloud mode", () => {
    expect(resolveLiteQuickCreateTarget({
      selectedNotebookId: null,
      notebooks: [],
      isLocalMode: true,
    })).toEqual({ kind: "create-default-local" });

    expect(resolveLiteQuickCreateTarget({
      selectedNotebookId: null,
      notebooks: [],
      isLocalMode: false,
    })).toEqual({ kind: "no-notebook" });
  });
});

describe("MobileLiteBottomBar", () => {
  it("renders 5 labeled actions, supports quick tap and long press on create, and hides when requested", () => {
    vi.useFakeTimers();
    const onTapNotes = vi.fn();
    const onLongPressNotes = vi.fn();
    const onTapDirectory = vi.fn();
    const onQuickCreate = vi.fn();
    const onLongPressCreate = vi.fn();
    const onTapSearch = vi.fn();
    const onTapMore = vi.fn();

    renderNode(
      <MobileLiteBottomBar
        activeTab="notes"
        onTapNotes={onTapNotes}
        onLongPressNotes={onLongPressNotes}
        onTapDirectory={onTapDirectory}
        onQuickCreate={onQuickCreate}
        onLongPressCreate={onLongPressCreate}
        onTapSearch={onTapSearch}
        onTapMore={onTapMore}
      />,
    );

    const tabs = host.querySelectorAll("[data-mobile-lite-tab]");
    expect(tabs).toHaveLength(5);
    expect(host.textContent).toContain("笔记");
    expect(host.textContent).toContain("目录");
    expect(host.textContent).toContain("新建");
    expect(host.textContent).toContain("搜索");
    expect(host.textContent).toContain("更多");

    const createBtn = host.querySelector<HTMLButtonElement>('[data-mobile-lite-tab="create"]')!;
    act(() => {
      createBtn.click();
    });
    expect(onQuickCreate).toHaveBeenCalledTimes(1);

    // 模拟右键/长按弹出次级新建菜单
    act(() => {
      createBtn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(onLongPressCreate).toHaveBeenCalledTimes(1);

    // 编辑态或键盘弹起时隐藏底栏
    renderNode(
      <MobileLiteBottomBar
        activeTab="notes"
        hidden
        onTapNotes={onTapNotes}
        onLongPressNotes={onLongPressNotes}
        onTapDirectory={onTapDirectory}
        onQuickCreate={onQuickCreate}
        onLongPressCreate={onLongPressCreate}
        onTapSearch={onTapSearch}
        onTapMore={onTapMore}
      />,
    );
    expect(host.querySelector("[data-mobile-lite-bottom-bar]")).toBeNull();
  });
});

describe("MobileLiteMoreSheet", () => {
  it("provides one-tap switch back to Full Mode and consumes Android back button first", () => {
    const onClose = vi.fn();
    const onSwitchToFullMode = vi.fn();

    renderNode(
      <MobileLiteMoreSheet
        open
        onClose={onClose}
        onSwitchToFullMode={onSwitchToFullMode}
      />,
    );

    const switchBtn = host.querySelector<HTMLButtonElement>("[data-mobile-lite-switch-full]");
    expect(switchBtn).not.toBeNull();
    expect(switchBtn?.textContent).toContain("切回完整模式");

    // Android 返回键优先关闭「更多」底抽屉
    expect(consumeMobileBack()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);

    // 点击「切回完整模式」
    act(() => {
      switchBtn?.click();
    });
    expect(onSwitchToFullMode).toHaveBeenCalledTimes(1);
  });

  it("hides AI module when AI connection is unavailable", () => {
    envMock.aiAvailable = false;
    renderNode(
      <MobileLiteMoreSheet
        open
        onClose={vi.fn()}
        onSwitchToFullMode={vi.fn()}
      />,
    );
    expect(host.querySelector('[data-mobile-lite-more-item="ai-chat"]')).toBeNull();
    expect(host.querySelector('[data-mobile-lite-more-item="trash"]')).not.toBeNull();
    expect(host.querySelector('[data-mobile-lite-more-item="settings"]')).not.toBeNull();
  });
});
