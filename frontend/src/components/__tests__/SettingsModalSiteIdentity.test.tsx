import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  loaded: false,
  config: { title: "nowen-note", favicon: "", shareFooterText: "", sharePageWidth: "standard", shareBannerEnabled: false, shareBannerImage: "", editorFontFamily: "" },
  save: vi.fn(async () => {}),
}));
vi.mock("@/hooks/useSiteSettings", () => ({
  useSiteSettings: () => ({ siteConfig: mock.config, isLoaded: mock.loaded, updateSiteConfig: mock.save, updateEditorFont: vi.fn() }),
  BUILTIN_FONTS: [{ id: "", nameKey: "default", family: "sans-serif" }],
  getBuiltinFontName: () => "default",
}));
vi.mock("@/hooks/useUserPreferences", () => ({ useUserPreferences: () => ({ prefs: { readingDensity: "cozy", editorFontSize: 0 }, setPref: vi.fn() }) }));
vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: {}, actions: {} }), useAppActions: () => ({}) }));
vi.mock("@/components/SkinSwitcher", () => ({ default: () => null }));
vi.mock("@/components/ThemeToggle", () => ({ default: () => null }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh-CN" } }),
}));

import { api } from "@/lib/api";
import SettingsModal from "../SettingsModal";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("站点标识异步加载", () => {
  let host: HTMLDivElement;
  let root: Root;
  const close = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("__APP_VERSION__", "test");
    mock.loaded = false;
    mock.config = { title: "nowen-note", favicon: "", shareFooterText: "", sharePageWidth: "standard", shareBannerEnabled: false, shareBannerImage: "", editorFontFamily: "" };
    mock.save.mockClear();
    vi.spyOn(api, "getMe").mockResolvedValue({ id: "admin", username: "admin", role: "admin" } as never);
    vi.spyOn(api, "getFonts").mockResolvedValue([]);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  function titleInput() { return document.querySelector<HTMLInputElement>('input[maxlength="20"]')!; }
  function saveButton() { return Array.from(document.querySelectorAll("button")).find(button => button.textContent === "settings.saveChanges")!; }

  it("配置加载完成之前，管理员也不能编辑或保存站点品牌", async () => {
    await act(async () => root.render(<SettingsModal onClose={close} />));
    expect(Array.from(document.querySelectorAll("button")).some(button => button.textContent === "settings.plugins")).toBe(false);
    expect(titleInput().disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>("#site-share-page-width")?.disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it("晚到的配置填充原品牌，只修改横幅时不覆盖站点名称、图标和页尾文字", async () => {
    await act(async () => root.render(<SettingsModal onClose={close} />));
    mock.config = { title: "原站点", favicon: "data:image/png;base64,AA==", shareFooterText: "原页尾", sharePageWidth: "wide", shareBannerEnabled: false, shareBannerImage: "data:image/jpeg;base64,aW1hZ2U=", editorFontFamily: "" };
    mock.loaded = true;
    await act(async () => root.render(<SettingsModal onClose={close} />));
    expect(titleInput().value).toBe("原站点");
    expect(document.querySelector<HTMLInputElement>("#site-share-footer-text")?.value).toBe("原页尾");
    const enabled = document.querySelector<HTMLInputElement>('[data-share-banner-editor] input[type="checkbox"]')!;
    act(() => enabled.click());
    await act(async () => saveButton().click());
    expect(mock.save).toHaveBeenLastCalledWith("原站点", "data:image/png;base64,AA==", "原页尾", "wide", { enabled: true, image: "data:image/jpeg;base64,aW1hZ2U=" });
  });
});
