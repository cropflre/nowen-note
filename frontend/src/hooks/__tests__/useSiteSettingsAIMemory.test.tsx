import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteSettingsProvider, useSiteSettings } from "../useSiteSettings";
import { api } from "@/lib/api";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function waitFor(assertion: () => void) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 1000) {
    try { assertion(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw lastError;
}

describe("AI 对话归档的实例开关", () => {
  let root: Root;
  let host: HTMLElement;
  let toggle: (enabled: boolean) => Promise<void>;
  function Status() {
    const { siteConfig, updateAIMemoryEnabled, isLoaded } = useSiteSettings();
    toggle = updateAIMemoryEnabled;
    return <span data-testid="flag">{isLoaded ? String(siteConfig.aiMemoryEnabled) : "loading"}</span>;
  }
  const flag = () => host.querySelector('[data-testid="flag"]')?.textContent;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

  it("is off until the server reports it on, including servers that do not know the switch", async () => {
    vi.spyOn(api, "getSiteSettingsPublic").mockResolvedValue({ site_title: "nowen-note", site_favicon: "", editor_font_family: "" });
    await act(async () => root.render(<SiteSettingsProvider><Status /></SiteSettingsProvider>));
    await waitFor(() => expect(flag()).toBe("false"));
  });

  it("follows the server and an administrator's change", async () => {
    vi.spyOn(api, "getSiteSettingsPublic").mockResolvedValue({ site_title: "nowen-note", site_favicon: "", editor_font_family: "", feature_ai_memory_enabled: "true" });
    const update = vi.spyOn(api, "updateSiteSettings").mockResolvedValue({ site_title: "nowen-note", site_favicon: "", editor_font_family: "", feature_ai_memory_enabled: "false" });
    await act(async () => root.render(<SiteSettingsProvider><Status /></SiteSettingsProvider>));
    await waitFor(() => expect(flag()).toBe("true"));
    await act(async () => { await toggle(false); });
    expect(update).toHaveBeenCalledWith({ feature_ai_memory_enabled: false });
    expect(flag()).toBe("false");
  });

  it("keeps the current value when the server refuses the change", async () => {
    vi.spyOn(api, "getSiteSettingsPublic").mockResolvedValue({ site_title: "nowen-note", site_favicon: "", editor_font_family: "" });
    vi.spyOn(api, "updateSiteSettings").mockRejectedValue(Object.assign(new Error("仅管理员可修改系统开关"), { status: 403 }));
    await act(async () => root.render(<SiteSettingsProvider><Status /></SiteSettingsProvider>));
    await waitFor(() => expect(flag()).toBe("false"));
    await act(async () => { await expect(toggle(true)).rejects.toThrow(); });
    expect(flag()).toBe("false");
  });
});
