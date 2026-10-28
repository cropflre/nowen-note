import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), available: vi.fn(), update: vi.fn(), discoverModels: vi.fn(), changed: vi.fn() }));
vi.mock("@/lib/aiProfiles", () => ({ aiProfiles: mocks, emitAIProfilesChanged: mocks.changed, getAIProfilesScope: () => "session-a" }));
vi.mock("@/components/settings/PluginPromptPackSettingsSection", () => ({ default: () => null }));
vi.mock("@/components/SpeechSettingsPanel", () => ({ default: () => null }));
import AISettingsPanel from "../AISettingsPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("AI gateway profile editing", () => {
  let host: HTMLDivElement;
  let root: Root;
  const profile = { id: "gateway", name: "Gateway", provider: "custom", apiUrl: "https://gateway.example/v1", apiKey: "", apiKeySet: false, customHeaders: { "x-session": "****" }, model: "chat-test" };
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem("i18nextLng", "zh-CN");
    mocks.list.mockResolvedValue({ profiles: [profile], activeProfileId: profile.id });
    mocks.available.mockImplementation(async () => { const result = await mocks.list(); return { personalProfiles: result.profiles, sharedProfiles: [], active: {scope: "personal", id: result.activeProfileId}, sharedSupported: false, isAdmin: false }; });
    mocks.update.mockResolvedValue({ profile, activeProfileId: profile.id });
    mocks.discoverModels.mockResolvedValue({ models: [{ id: "chat-test", name: "Chat" }] });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); });
  async function input(label: string, value: string) {
    const element = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function click(text: string) {
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === text)!.click());
  }

  it("keeps advanced settings collapsed and saved values masked on an unchanged save", async () => {
    await act(async () => root.render(<AISettingsPanel />));
    expect(host.querySelector("details")!.open).toBe(false);
    const value = host.querySelector<HTMLInputElement>('input[aria-label="请求头值 1"]')!;
    expect(value.type).toBe("password");
    expect(value.value).toBe("****");
    await click("保存配置");
    expect(mocks.update).toHaveBeenCalledWith(profile.id, expect.objectContaining({ customHeaders: { "x-session": "****" } }));
  });

  it("saves edited header values, supports header-only model discovery and removes headers", async () => {
    await act(async () => root.render(<AISettingsPanel />));
    await input("请求头值 1", "new-session-secret");
    await click("刷新模型");
    expect(mocks.discoverModels).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "", customHeaders: { "x-session": "new-session-secret" } }), profile.id);
    await click("保存配置");
    expect(mocks.update).toHaveBeenLastCalledWith(profile.id, expect.objectContaining({ customHeaders: { "x-session": "new-session-secret" } }));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="移除请求头 1"]')!.click());
    await click("保存配置");
    expect(mocks.update).toHaveBeenLastCalledWith(profile.id, expect.objectContaining({ customHeaders: {} }));
  });

  it("offers native Anthropic and clears previous gateway credentials when changing provider", async () => {
    await act(async () => root.render(<AISettingsPanel />));
    const select = host.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { select.value = "anthropic"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.querySelector<HTMLInputElement>('input[placeholder="https://api.example.com/v1"]')!.value).toBe("https://api.anthropic.com/v1");
    expect(host.querySelector('input[aria-label="请求头值 1"]')).toBeNull();
  });
});
