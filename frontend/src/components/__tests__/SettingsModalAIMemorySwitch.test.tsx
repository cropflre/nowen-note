import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  enabled: false,
  update: vi.fn<[boolean], Promise<void>>(async () => {}),
}));
vi.mock("@/hooks/useSiteSettings", () => ({
  useSiteSettings: () => ({
    siteConfig: { title: "nowen-note", favicon: "", shareFooterText: "", sharePageWidth: "standard", shareBannerEnabled: false, shareBannerImage: "", editorFontFamily: "", aiMemoryEnabled: mock.enabled },
    isLoaded: true, updateSiteConfig: vi.fn(), updateEditorFont: vi.fn(), updateAIMemoryEnabled: mock.update,
  }),
  BUILTIN_FONTS: [{ id: "", nameKey: "default", family: "sans-serif" }],
  getBuiltinFontName: () => "default",
}));
vi.mock("@/hooks/useUserPreferences", async () => {
  const { DEFAULT_USER_PREFERENCES } = await import("@/lib/userPreferenceAccountCache");
  return { useUserPreferences: () => ({ prefs: DEFAULT_USER_PREFERENCES, setPref: vi.fn() }) };
});
vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: { viewMode: "all" }, actions: {} }), useAppActions: () => ({ setViewMode: vi.fn() }) }));
vi.mock("@/components/SkinSwitcher", () => ({ default: () => null }));
vi.mock("@/components/ThemeToggle", () => ({ default: () => null }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh-CN" } }),
}));

import { api } from "@/lib/api";
import SettingsModal from "../SettingsModal";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("开关页里的 AI 对话归档", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("__APP_VERSION__", "test");
    mock.enabled = false; mock.update.mockClear();
    vi.spyOn(api, "getSiteSettings").mockResolvedValue({ site_title: "nowen-note", site_favicon: "", editor_font_family: "", web_ui_enabled: "true" });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const checkbox = () => Array.from(document.querySelectorAll("label"))
    .find((label) => label.textContent?.includes("aiMemory.switchTitle"))?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;

  it("shows off when the server does not report it on, and an administrator can switch it on", async () => {
    vi.spyOn(api, "getMe").mockResolvedValue({ id: "admin", username: "admin", role: "admin" } as never);
    await act(async () => root.render(<SettingsModal defaultTab="switches" onClose={vi.fn()} />));
    expect(checkbox()).not.toBeNull();
    expect(checkbox()!.checked).toBe(false);
    await act(async () => checkbox()!.click());
    expect(mock.update).toHaveBeenCalledWith(true);
    expect(checkbox()!.checked).toBe(true);
  });

  it("goes back to off when the server refuses", async () => {
    vi.spyOn(api, "getMe").mockResolvedValue({ id: "admin", username: "admin", role: "admin" } as never);
    mock.update.mockRejectedValueOnce(new Error("仅管理员可修改系统开关"));
    await act(async () => root.render(<SettingsModal defaultTab="switches" onClose={vi.fn()} />));
    await act(async () => checkbox()!.click());
    expect(checkbox()!.checked).toBe(false);
  });

  it("is not offered to other members", async () => {
    vi.spyOn(api, "getMe").mockResolvedValue({ id: "member", username: "member", role: "user" } as never);
    await act(async () => root.render(<SettingsModal defaultTab="switches" onClose={vi.fn()} />));
    expect(checkbox()).toBeNull();
  });
});
