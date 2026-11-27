// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionGlobalConfig } from "framer-motion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  setPref: vi.fn(),
  updateSiteConfig: vi.fn(async () => {}),
  updateEditorFont: vi.fn(async () => {}),
  changeLanguage: vi.fn(async () => {}),
}));

vi.mock("@/hooks/useSiteSettings", () => ({
  useSiteSettings: () => ({
    siteConfig: {
      title: "Nowen",
      favicon: "",
      shareFooterText: "",
      sharePageWidth: "standard",
      shareBannerEnabled: false,
      shareBannerImage: "",
      editorFontFamily: "",
    },
    isLoaded: true,
    updateSiteConfig: mock.updateSiteConfig,
    updateEditorFont: mock.updateEditorFont,
  }),
  BUILTIN_FONTS: [{ id: "", nameKey: "default", family: "sans-serif" }],
  getBuiltinFontName: () => "默认字体",
}));

vi.mock("@/hooks/useUserPreferences", async () => {
  const { DEFAULT_USER_PREFERENCES } = await import("@/lib/userPreferenceAccountCache");
  return {
    useUserPreferences: () => ({
      prefs: DEFAULT_USER_PREFERENCES,
      setPref: mock.setPref,
    }),
  };
});

vi.mock("@/hooks/useSidebarTextStyle", () => ({ useSidebarTextStyle: () => ["readable", vi.fn()] }));
vi.mock("@/hooks/useKnowledgeTreeDisplaySize", () => ({ useKnowledgeTreeDisplaySize: () => ["default", vi.fn()] }));
vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: {}, actions: {} }), useAppActions: () => ({}) }));
vi.mock("@/components/SkinSwitcher", () => ({ default: () => <div data-testid="skin-switcher" /> }));
vi.mock("@/components/ThemeToggle", () => ({ default: () => <div data-testid="theme-toggle" /> }));
vi.mock("@/components/DownloadPanel", () => ({ default: () => <div data-testid="download-panel" /> }));
import { zhCNEcosystemTranslations } from "@/i18n/ecosystemTranslations";

function lookupEcosystemKey(key: string): unknown {
  if (!key.startsWith("ecosystem.")) return undefined;
  return key
    .split(".")
    .reduce<unknown>(
      (acc, seg) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[seg] : undefined),
      zhCNEcosystemTranslations,
    );
}

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; returnObjects?: boolean }) => {
      const hit = lookupEcosystemKey(key);
      if (hit !== undefined) return hit;
      return opts?.defaultValue || key;
    },
    i18n: { language: "zh-CN", resolvedLanguage: "zh-CN", changeLanguage: mock.changeLanguage },
  }),
}));

import { api } from "@/lib/api";
import SettingsModal from "../SettingsModal";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
MotionGlobalConfig.skipAnimations = true;

describe("SettingsModal playful & tactile shell", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("__APP_VERSION__", "1.6.2");
    mock.setPref.mockClear();
    vi.spyOn(api, "getMe").mockResolvedValue({ id: "u1", username: "alice", role: "user" } as never);
    vi.spyOn(api, "getFonts").mockResolvedValue([]);
    vi.spyOn(api, "getVersion").mockResolvedValue({ appVersion: "1.6.2" } as never);
    vi.spyOn(api, "getLatestRelease").mockResolvedValue({ available: false, reason: "offline" } as never);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders grouped playful navigation, quick search filter, and tactile segmented controls", async () => {
    await act(async () => root.render(<SettingsModal onClose={vi.fn()} />));

    const modalText = document.body.textContent || "";
    expect(modalText).toContain("个性与手感");
    expect(modalText).toContain("智能与效率");
    expect(modalText).toContain("数据与同步");
    expect(modalText).toContain("空间与系统");

    // Quick search filters sidebar tabs via keywords
    const searchInput = document.body.querySelector<HTMLInputElement>('input[placeholder*="快速查找设置"]')!;
    expect(searchInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(searchInput, "快捷键");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const navButtons = Array.from(document.body.querySelectorAll("nav button"));
    expect(navButtons.length).toBe(1);
    expect(navButtons[0].textContent).toContain("auditI18n.shortcuts");

    // Clear search to restore all tabs
    const clearButton = document.body.querySelector<HTMLButtonElement>('button[aria-label="清空搜索"]')!;
    await act(async () => clearButton.click());
    expect(document.body.querySelectorAll("nav button").length).toBeGreaterThan(5);

    // Tactile emblem boop easter egg increments after 3 clicks
    const heroEmblem = document.body.querySelector<HTMLButtonElement>('button[title="settings.appearance"]')!;
    await act(async () => {
      heroEmblem.click();
      heroEmblem.click();
      heroEmblem.click();
    });
    expect(document.body.textContent).toContain("手感不错 ×3");

    // Playful segmented control updates font size preference
    const size18 = Array.from(document.body.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "18",
    )!;
    await act(async () => size18.click());
    expect(mock.setPref).toHaveBeenCalledWith("editorFontSize", 18);
  });

  it("renders playful About logo boop counter and switches tabs smoothly", async () => {
    await act(async () => root.render(<SettingsModal defaultTab="about" onClose={vi.fn()} />));

    const logoButton = document.body.querySelector<HTMLButtonElement>('button[title="点一下给 Nowen 打 call"]')!;
    expect(logoButton).toBeTruthy();
    await act(async () => {
      logoButton.click();
      logoButton.click();
    });
    expect(document.body.textContent).toContain("✨ ×2");

    // Jump from About promo card directly to Nowen Ecosystem tab
    const ecoJumpBtn = Array.from(document.body.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("探索弄文生态家族"),
    )!;
    expect(ecoJumpBtn).toBeTruthy();
    await act(async () => ecoJumpBtn.click());

    const text = document.body.textContent || "";
    expect(text).toContain("弄文影视");
    expect(text).toContain("弄文阅读");
    expect(text).toContain("弄文书签");
    expect(text).toContain("NOWEN弄文");

    // Verify WeChat Mini Program QR code renders and opens Lightbox on click
    const qrBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="NOWEN弄文微信小程序码"]')!;
    expect(qrBtn).toBeTruthy();
    await act(async () => qrBtn.click());
    expect(document.body.querySelector('[role="dialog"][aria-label="NOWEN弄文微信小程序码"]')).toBeTruthy();

    // Copy WeChat Mini Program name with joyful feedback
    const copyMiniBtn = Array.from(document.body.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("复制小程序名"),
    )!;
    await act(async () => copyMiniBtn.click());
    expect(document.body.textContent).toContain("已复制，去微信搜一搜粘贴");
  });
});
