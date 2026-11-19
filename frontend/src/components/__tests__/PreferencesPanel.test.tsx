import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserPreferences } from "@/lib/userPreferenceAccountCache";

// One shared preference store, like UserPreferencesProvider: every component sees each write.
const store = vi.hoisted(() => {
  let prefs = {} as UserPreferences;
  const listeners = new Set<() => void>();
  const set = (next: UserPreferences) => {
    prefs = next;
    listeners.forEach((listener) => listener());
  };
  return {
    get: () => prefs,
    set,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setPref: vi.fn((key: keyof UserPreferences, value: unknown) => set({ ...prefs, [key]: value })),
  };
});
const runtime = vi.hoisted(() => ({ android: false, local: false }));
const app = vi.hoisted(() => ({ viewMode: "all", setViewMode: vi.fn() }));

vi.mock("@/hooks/useUserPreferences", async () => {
  const React = await import("react");
  return {
    useUserPreferences: () => ({
      prefs: React.useSyncExternalStore(store.subscribe, store.get),
      setPref: store.setPref,
    }),
  };
});
vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: { viewMode: app.viewMode } }),
  useAppActions: () => ({ setViewMode: app.setViewMode }),
}));
vi.mock("@/lib/mobileLocalMode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/mobileLocalMode")>(),
  isAndroidNativeRuntime: () => runtime.android,
  isMobileLocalMode: () => runtime.local,
}));

import i18n from "@/i18n";
import { toast } from "@/lib/toast";
import { DEFAULT_USER_PREFERENCES } from "@/lib/userPreferenceAccountCache";
import PreferencesPanel, { type PreferencesPanelProps } from "../settings/preferences/PreferencesPanel";
import { searchPreferences, type PreferenceSearchEntry } from "../settings/preferences/preferenceSearch";
import { MOBILE_LAYOUT_QUERY } from "../settings/preferences/useDeviceLayoutPreferences";
import { revealSettingsTarget } from "../settings/preferences/revealSettingsTarget";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
const onOpenRelatedSetting = vi.fn();

function render(props: Partial<PreferencesPanelProps> = {}) {
  act(() => root.render(
    <PreferencesPanel
      isAdmin={false}
      relatedTabLabels={{ security: "账号安全", ai: "AI 助手", users: "用户管理" }}
      onOpenRelatedSetting={onOpenRelatedSetting}
      {...props}
    />,
  ));
}

const query = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector);
const row = (id: string) => query(`[data-preference-id="${id}"]`);
const switchOf = (id: string) => query<HTMLInputElement>(`[data-preference-id="${id}"] input[role="switch"]`);
const page = () => query("[data-preferences-page]")?.getAttribute("data-preferences-page");
const click = (element: Element | null) => act(() => { (element as HTMLElement).click(); });
const key = (element: Element | null, keyName: string) => act(() => {
  element!.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true }));
});
const openCategory = (name: string) => click(row(`category-${name}`));

function search(text: string) {
  const input = query<HTMLInputElement>("[data-preferences-search]")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

const results = () => Array.from(host.querySelectorAll<HTMLButtonElement>("[data-preference-result]"));
const resultTitles = () => results().map((button) => button.querySelector("[id]")?.textContent);

function useMobileLayout(mobile: boolean) {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: mobile && media === MOBILE_LAYOUT_QUERY,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
}

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

beforeEach(() => {
  localStorage.clear();
  store.set({ ...DEFAULT_USER_PREFERENCES });
  store.setPref.mockClear();
  runtime.android = false;
  runtime.local = false;
  app.viewMode = "all";
  app.setViewMode.mockClear();
  onOpenRelatedSetting.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as { nowenDesktop?: unknown }).nowenDesktop;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("使用偏好首页", () => {
  it("shows three common settings and the categories instead of the long list", () => {
    render();
    expect(query("h3")?.textContent).toBe("使用偏好");
    for (const id of ["enableNoteTabs", "markdownDefaultViewMode", "remoteImagePasteMode"]) expect(row(id), id).not.toBeNull();
    for (const id of ["codeBlockWordWrap", "lockOnOpen", "showTemplateManagement", "desktopKnowledgeTreeMode", "mobileRailHidden"]) {
      expect(row(id), id).toBeNull();
    }
    expect(row("category-navigation")?.textContent).toContain("已显示 7/8 个导航模块");
    expect(row("category-navigation")?.textContent).toContain("管理");
    for (const name of ["editing", "layout", "advanced"]) expect(row(`category-${name}`), name).not.toBeNull();
    expect(query('[data-preference-scope="account"]')?.textContent).toBe("账号同步");
  });

  it("saves the same account preferences as the old Switches page", () => {
    render();
    click(switchOf("enableNoteTabs"));
    expect(store.setPref).toHaveBeenLastCalledWith("enableNoteTabs", true);

    const source = query<HTMLButtonElement>('[data-preference-id="markdownDefaultViewMode"] [role="radio"][aria-checked="true"]');
    expect(source?.textContent).toBe("源码");
    expect(source?.tabIndex).toBe(0);
    key(source, "ArrowRight");
    expect(store.setPref).toHaveBeenLastCalledWith("markdownDefaultViewMode", "preview");
    const preview = query<HTMLButtonElement>('[data-preference-id="markdownDefaultViewMode"] [role="radio"][aria-checked="true"]');
    expect(preview?.textContent).toBe("预览");
    expect(document.activeElement).toBe(preview);

    const select = query<HTMLSelectElement>('[data-preference-id="remoteImagePasteMode"] select')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "ask");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(store.setPref).toHaveBeenLastCalledWith("remoteImagePasteMode", "ask");
    expect(select.selectedOptions[0].textContent).toBe("每次询问");
  });
});

describe("搜索", () => {
  it("finds an option inside a folded category and opens it in place", () => {
    render();
    const input = search("代码换行");
    expect(resultTitles()).toEqual(["代码块自动换行"]);
    expect(results()[0].textContent).toContain("编辑与阅读 › 更多选项");

    key(input, "Enter");
    expect(page()).toBe("editing");
    expect(query('[data-preference-id="editing-more"] > button')?.getAttribute("aria-expanded")).toBe("true");
    expect(row("codeBlockWordWrap")?.hasAttribute("data-settings-highlight")).toBe(true);
    expect(document.activeElement).toBe(switchOf("codeBlockWordWrap"));

    click(query("[data-preferences-back]"));
    expect(page()).toBe("home");
    expect(document.activeElement).toBe(query("[data-preferences-search]"));
    expect(resultTitles()).toEqual(["代码块自动换行"]);
  });

  it("supports keyboard movement through results and says when nothing matches", () => {
    render();
    const input = search("代码");
    expect(resultTitles()).toEqual(["代码块自动换行", "代码块默认展示"]);
    key(input, "ArrowDown");
    expect(document.activeElement).toBe(results()[0]);
    key(results()[0], "ArrowDown");
    expect(document.activeElement).toBe(results()[1]);
    key(results()[1], "ArrowUp");
    key(results()[0], "ArrowUp");
    expect(document.activeElement).toBe(input);
    key(input, "Escape");
    expect(input.value).toBe("");
    expect(row("category-editing")).not.toBeNull();

    search("完全不存在的设置");
    expect(host.textContent).toContain("没有找到与「完全不存在的设置」相关的设置");
  });

  it("finds navigation and Task Center modules by name", () => {
    render();
    search("导航模块");
    expect(resultTitles()[0]).toBe("导航模块");
    click(results()[0]);
    expect(page()).toBe("navigation");
    expect(row("navigation-modules")?.hasAttribute("data-settings-highlight")).toBe(true);
    expect(row("navigation-modules")?.contains(document.activeElement)).toBe(true);
    click(query("[data-preferences-back]"));

    search("习惯");
    expect(resultTitles()).toEqual(["习惯"]);
    click(results()[0]);
    expect(page()).toBe("navigation");
    expect(query('[data-preference-id="task-center-modules"] > button')?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(switchOf("task-center-module-habits"));
  });

  it("leads to settings that moved to other tabs, and only offers admin settings to administrators", () => {
    render();
    search("日记密码");
    expect(resultTitles()).toEqual(["日记隐私"]);
    expect(results()[0].textContent).toContain("账号安全");
    click(results()[0]);
    expect(onOpenRelatedSetting).toHaveBeenLastCalledWith("security", "journal-privacy");

    search("网页端");
    expect(resultTitles()).toEqual([]);

    render({ isAdmin: true });
    search("网页端");
    expect(resultTitles()).toEqual(["网页端访问"]);
    click(results()[0]);
    expect(onOpenRelatedSetting).toHaveBeenLastCalledWith("users", "web-ui-access");
    search("对话归档");
    expect(resultTitles()).toEqual(["AI 对话归档"]);
    click(results()[0]);
    expect(onOpenRelatedSetting).toHaveBeenLastCalledWith("ai", "ai-memory-archive");
  });
});

describe("导航与模块", () => {
  it("keeps hiding, ordering, drag and drop, and leaves a module that was just hidden", () => {
    app.viewMode = "files";
    render();
    openCategory("navigation");
    expect(page()).toBe("navigation");
    expect(document.activeElement).toBe(query("h3"));
    const order = () => Array.from(host.querySelectorAll("[data-navigation-module-order-item]"))
      .map((element) => element.getAttribute("data-navigation-module-order-item"));
    expect(order()).toEqual(["notifications", "favorites", "files", "diary", "tasks", "mindmaps", "ai-chat", "shares"]);
    expect(switchOf("navigation-module-notifications")?.checked).toBe(false);

    click(switchOf("navigation-module-favorites"));
    expect(store.setPref).toHaveBeenLastCalledWith("hiddenNavigationModules", ["notifications", "favorites"]);
    expect(app.setViewMode).not.toHaveBeenCalled();
    click(switchOf("navigation-module-files"));
    expect(app.setViewMode).toHaveBeenCalledWith("all");

    click(query('[aria-label="上移「思维导图」"]'));
    expect(order()).toEqual(["notifications", "favorites", "files", "diary", "mindmaps", "tasks", "ai-chat", "shares"]);
    expect(query<HTMLButtonElement>('[aria-label="上移「通知」"]')?.disabled).toBe(true);

    const dragged = query('[data-navigation-module-order-item="shares"]')!;
    const target = query('[data-navigation-module-order-item="favorites"]')!;
    act(() => { dragged.dispatchEvent(new Event("dragstart", { bubbles: true })); });
    act(() => { target.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true })); });
    expect(order()).toEqual(["notifications", "shares", "favorites", "files", "diary", "mindmaps", "tasks", "ai-chat"]);
    expect(store.setPref).toHaveBeenLastCalledWith("navigationModuleOrder", order());
  });

  it("folds Task Center modules until they are managed", () => {
    render();
    openCategory("navigation");
    const toggle = query('[data-preference-id="task-center-modules"] > button')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("已显示 5/5");
    click(toggle);
    click(switchOf("task-center-module-habits"));
    expect(store.setPref).toHaveBeenLastCalledWith("hiddenTaskCenterModules", ["habits"]);
    expect(query('[data-preference-id="task-center-modules"] > button')?.textContent).toContain("已显示 4/5");

    click(query("[data-preferences-back]"));
    expect(document.activeElement).toBe(row("category-navigation"));
  });
});

describe("编辑与阅读", () => {
  it("puts frequent options first and folds the rest", () => {
    render();
    openCategory("editing");
    const ids = Array.from(host.querySelectorAll("[data-preference-id]")).map((element) => element.getAttribute("data-preference-id"));
    expect(ids).toEqual(["markdownDefaultViewMode", "remoteImagePasteMode", "enableNoteTabs", "outlineDefaultOpen", "editing-more"]);
    click(query('[data-preference-id="editing-more"] > button'));
    click(switchOf("codeBlockWordWrap"));
    expect(store.setPref).toHaveBeenLastCalledWith("codeBlockWordWrap", false);
    click(switchOf("lockOnOpen"));
    expect(store.setPref).toHaveBeenLastCalledWith("lockOnOpen", true);
    click(switchOf("outlineDefaultOpen"));
    expect(store.setPref).toHaveBeenLastCalledWith("outlineDefaultOpen", true);
  });
});

describe("界面与布局", () => {
  it("offers only the desktop layout options in a desktop-width window", () => {
    useMobileLayout(false);
    render();
    openCategory("layout");
    for (const id of ["showTemplateManagement", "noteTitleAsAppTitle", "showNoteListDividers", "desktopKnowledgeTreeMode"]) expect(row(id), id).not.toBeNull();
    for (const id of ["mobileRailHidden", "mobileKnowledgeTreeMode", "mobileKnowledgeTreeCompact", "desktopHideMenuBar"]) expect(row(id), id).toBeNull();
    expect(host.textContent).toContain("此设备 · 桌面布局");
    expect(query('[data-preference-scope="device"]')?.textContent).toBe("仅本设备");

    click(switchOf("desktopKnowledgeTreeMode"));
    expect(localStorage.getItem("nowen.desktopKnowledgeTree.viewMode.v1")).toBe("quick");
    click(switchOf("showNoteListDividers"));
    expect(store.setPref).toHaveBeenLastCalledWith("showNoteListDividers", true);

    click(query("[data-preferences-back]"));
    search("快捷栏");
    expect(resultTitles()).toEqual([]);
  });

  it("offers only the phone layout options in a phone-width window", () => {
    useMobileLayout(true);
    render();
    openCategory("layout");
    expect(row("desktopKnowledgeTreeMode")).toBeNull();
    expect(host.textContent).toContain("此设备 · 手机布局");
    click(switchOf("mobileRailHidden"));
    click(switchOf("mobileKnowledgeTreeMode"));
    click(switchOf("mobileKnowledgeTreeCompact"));
    expect(localStorage.getItem("nowen-mobile-rail-hidden")).toBe("true");
    expect(localStorage.getItem("nowen.mobileKnowledgeTree.viewMode.v1")).toBe("tree");
    expect(localStorage.getItem("nowen.mobileKnowledgeTree.compact.v1")).toBe("true");
    expect(store.setPref).not.toHaveBeenCalled();
  });

  it("rolls the desktop menu bar back and explains why when saving fails", async () => {
    const setHideMenuBar = vi.fn().mockRejectedValue(new Error("写入失败"));
    Object.assign(window, { nowenDesktop: { getAppInfo: async () => ({ platform: "win32", hideMenuBar: true }), setHideMenuBar } });
    const error = vi.spyOn(toast, "error");
    render();
    await act(async () => {});
    openCategory("layout");
    expect(switchOf("desktopHideMenuBar")?.checked).toBe(true);
    await act(async () => { switchOf("desktopHideMenuBar")!.click(); });
    expect(setHideMenuBar).toHaveBeenCalledWith(false);
    expect(switchOf("desktopHideMenuBar")?.checked).toBe(true);
    expect(error).toHaveBeenCalledWith("保存失败，已恢复原设置：写入失败");
  });

  it("does not offer the menu bar on macOS", async () => {
    Object.assign(window, { nowenDesktop: { getAppInfo: async () => ({ platform: "darwin", hideMenuBar: false }), setHideMenuBar: vi.fn() } });
    render();
    await act(async () => {});
    openCategory("layout");
    expect(row("desktopHideMenuBar")).toBeNull();
  });
});

describe("高级选项与存储范围", () => {
  it("lists moved settings by permission and opens their tabs", () => {
    render();
    openCategory("advanced");
    expect(row("journal-privacy")?.textContent).toContain("账号安全");
    expect(row("ai-memory-archive")).toBeNull();
    expect(row("web-ui-access")).toBeNull();
    click(row("journal-privacy"));
    expect(onOpenRelatedSetting).toHaveBeenLastCalledWith("security", "journal-privacy");

    render({ isAdmin: true });
    expect(row("ai-memory-archive")?.textContent).toContain("管理员");
    click(row("web-ui-access"));
    expect(onOpenRelatedSetting).toHaveBeenLastCalledWith("users", "web-ui-access");
  });

  it("says when account preferences stay on this device", () => {
    runtime.android = true;
    runtime.local = true;
    render();
    expect(host.textContent).toContain("仅此设备模式：所有偏好只保存在这台设备上。");
    expect(query('[data-preference-scope]')?.getAttribute("data-preference-scope")).toBe("device");
    expect(row("category-advanced")).toBeNull();

    runtime.local = false;
    act(() => root.unmount());
    root = createRoot(host);
    render();
    expect(host.textContent).toContain("当前未开启同步");
  });
});

describe("searchPreferences", () => {
  const entry = (id: string, title: string, extra: Partial<PreferenceSearchEntry> = {}): PreferenceSearchEntry => ({
    id, title, path: ["分类"], target: { kind: "page", page: "editing" }, ...extra,
  });

  it("ranks title matches before keyword and description matches and requires every term", () => {
    const entries = [
      entry("a", "打开笔记时锁定", { description: "解锁后才能编辑" }),
      entry("b", "笔记标签页", { keywords: "tab tabs" }),
      entry("c", "编辑器字号"),
    ];
    expect(searchPreferences(entries, "编辑").map(({ id }) => id)).toEqual(["c", "a"]);
    expect(searchPreferences(entries, "TAB").map(({ id }) => id)).toEqual(["b"]);
    expect(searchPreferences(entries, "笔记 锁定").map(({ id }) => id)).toEqual(["a"]);
    expect(searchPreferences(entries, "   ")).toEqual([]);
    expect(searchPreferences([entry("d", "粘贴外部图片", { path: ["编辑与阅读"] })], "编辑").map(({ id }) => id)).toEqual(["d"]);
  });

  it("matches Chinese characters typed in order without the words in between", () => {
    const entries = [entry("wrap", "代码块自动换行"), entry("fold", "代码块默认展示")];
    expect(searchPreferences(entries, "代码换行").map(({ id }) => id)).toEqual(["wrap"]);
    expect(searchPreferences(entries, "换").map(({ id }) => id)).toEqual(["wrap"]);
  });
});

describe("revealSettingsTarget", () => {
  it("waits for a lazily rendered section and reveals it again when the panel re-mounts it", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const section = () => {
      const element = document.createElement("section");
      element.setAttribute("data-settings-section", "journal-privacy");
      element.append(document.createElement("button"));
      return element;
    };
    const stop = revealSettingsTarget(container, '[data-settings-section="journal-privacy"]', { focus: true });

    const first = section();
    container.append(first);
    await vi.waitFor(() => expect(first.hasAttribute("data-settings-highlight")).toBe(true));
    expect(document.activeElement).toBe(first.querySelector("button"));

    const second = section();
    first.replaceWith(second);
    await vi.waitFor(() => expect(second.hasAttribute("data-settings-highlight")).toBe(true));
    expect(document.activeElement).toBe(second.querySelector("button"));
    stop();
    container.remove();
  });
});
