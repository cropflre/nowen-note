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
// The AI tab is the reliability shell (as in the build); its inner editors load their own data and are stubbed.
vi.mock("@/components/AISettingsPanel", () => ({ default: () => <div data-testid="ai-profiles" /> }));
vi.mock("@/components/EmbeddingSettingsPanel", () => ({ default: () => null }));
vi.mock("@/lib/aiReliable", () => ({
  getReliableAIStatus: vi.fn(async () => ({
    enabled: false, provider: null, model: null, apiHost: null, embeddingModel: null,
    scope: { workspaceId: null, notebookCount: null },
    index: { lastIndexedAt: null, newestSourceUpdatedAt: null, pending: 0, processing: 0, failed: 0, totalNotes: 0, indexedNotes: 0, totalAttachments: 0, indexedAttachments: 0, configured: false, vectorAvailable: false },
  })),
  setReliableAIEnabled: vi.fn(),
}));
vi.mock("@/components/SkinSwitcher", () => ({ default: () => null }));
vi.mock("@/components/ThemeToggle", () => ({ default: () => null }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh-CN" } }),
}));

import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import SettingsModal from "../SettingsModal";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("AI 助手页里的 AI 对话归档开关", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("__APP_VERSION__", "test");
    mock.enabled = false; mock.update.mockClear();
    vi.spyOn(api, "getSiteSettings").mockResolvedValue({ site_title: "nowen-note", site_favicon: "", editor_font_family: "", web_ui_enabled: "true" });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const archiveSwitch = () =>
    document.querySelector<HTMLInputElement>('[data-settings-section="ai-memory-archive"] input[role="switch"]');

  it("shows off when the server does not report it on, and an administrator can switch it on", async () => {
    vi.spyOn(api, "getMe").mockResolvedValue({ id: "admin", username: "admin", role: "admin" } as never);
    await act(async () => root.render(<SettingsModal defaultTab="ai" onClose={vi.fn()} />));
    expect(archiveSwitch()).not.toBeNull();
    // Below the manual AI switch, above the profile editor, and outside the area dimmed when manual AI is off.
    const section = document.querySelector('[data-settings-section="ai-memory-archive"]')!;
    const profiles = document.querySelector('[data-testid="ai-profiles"]')!;
    expect(section.compareDocumentPosition(profiles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section.closest(".opacity-80")).toBeNull();
    expect(archiveSwitch()!.checked).toBe(false);
    await act(async () => archiveSwitch()!.click());
    expect(mock.update).toHaveBeenCalledWith(true);
    expect(archiveSwitch()!.checked).toBe(true);
  });

  it("goes back to off and says so when the server refuses", async () => {
    vi.spyOn(api, "getMe").mockResolvedValue({ id: "admin", username: "admin", role: "admin" } as never);
    const error = vi.spyOn(toast, "error");
    mock.update.mockRejectedValueOnce(new Error("仅管理员可修改系统开关"));
    await act(async () => root.render(<SettingsModal defaultTab="ai" onClose={vi.fn()} />));
    await act(async () => archiveSwitch()!.click());
    expect(archiveSwitch()!.checked).toBe(false);
    expect(error).toHaveBeenCalledWith("preferences.saveFailedReason");
  });

  it("is not offered to other members", async () => {
    vi.spyOn(api, "getMe").mockResolvedValue({ id: "member", username: "member", role: "user" } as never);
    await act(async () => root.render(<SettingsModal defaultTab="ai" onClose={vi.fn()} />));
    expect(document.querySelector('[data-testid="ai-profiles"]')).not.toBeNull();
    expect(archiveSwitch()).toBeNull();
  });

  it("is reachable from Preferences → Advanced, which opens the AI tab at the switch", async () => {
    vi.spyOn(api, "getMe").mockResolvedValue({ id: "admin", username: "admin", role: "admin" } as never);
    await act(async () => root.render(<SettingsModal defaultTab="preferences" onClose={vi.fn()} />));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-preference-id="category-advanced"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[data-preference-id="ai-memory-archive"]')!.click());
    await vi.waitFor(() => expect(archiveSwitch()).not.toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(archiveSwitch()));
    expect(document.querySelector('[data-settings-section="ai-memory-archive"]')!.hasAttribute("data-settings-highlight")).toBe(true);
  });
});
