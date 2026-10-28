import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scope: "account-a", available: vi.fn(), update: vi.fn(), create: vi.fn(), activate: vi.fn(), testDraft: vi.fn(), discoverModels: vi.fn(), changed: vi.fn(),
  shared: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), test: vi.fn() }, activateSelection: vi.fn(),
}));
vi.mock("@/lib/aiProfiles", () => ({ aiProfiles: mocks, emitAIProfilesChanged: mocks.changed, getAIProfilesScope: () => mocks.scope }));
vi.mock("@/components/settings/PluginPromptPackSettingsSection", () => ({ default: () => null }));
vi.mock("@/components/SpeechSettingsPanel", () => ({ default: () => null }));
import AISettingsPanel from "../AISettingsPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const personal = { id: "personal", name: "Personal", provider: "custom", apiUrl: "https://personal.example/v1", apiKey: "****", apiKeySet: true, model: "personal-chat" };
const shared = { id: "team", name: "Team AI", provider: "custom", model: "team-chat", enabled: true, revision: 4 };
const managed = { ...personal, ...shared, memberIds: ["member-a"] };
const baseAvailable = { personalProfiles: [personal], sharedProfiles: [shared], active: { scope: "personal", id: personal.id }, unavailable: false, sharedSupported: true, isAdmin: false, aiEnabled: true };

describe("shared AI profile settings", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks(); mocks.scope = "account-a";
    localStorage.setItem("i18nextLng", "zh-CN");
    mocks.available.mockResolvedValue(baseAvailable);
    mocks.discoverModels.mockResolvedValue({ models: [] });
    mocks.shared.list.mockResolvedValue({ profiles: [managed], members: [{ id: "member-a", username: "Alice" }, { id: "member-b", username: "Bob" }] });
    mocks.shared.update.mockResolvedValue({ profile: managed });
    mocks.shared.create.mockResolvedValue({ profile: managed });
    mocks.shared.test.mockResolvedValue({ success: true });
    mocks.activateSelection.mockResolvedValue({ active: {scope: "shared", id: shared.id} });
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.restoreAllMocks(); });
  async function click(text: string) { await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === text)!.click()); }
  async function mount(admin = false) { mocks.available.mockResolvedValue({ ...baseAvailable, isAdmin: admin }); await act(async () => root.render(<AISettingsPanel />)); }

  it("shows member profiles as read-only cards and enables only the selected server reference", async () => {
    await mount();
    const section = host.querySelector('section[aria-label="共享配置"]')!;
    expect(section.textContent).toContain("Team AI");
    expect(section.textContent).toContain("管理员提供");
    expect(section.querySelector("input")).toBeNull();
    expect(host.textContent).not.toContain("管理共享配置");
    await act(async () => section.querySelector<HTMLButtonElement>("button")!.click());
    expect(mocks.activateSelection).toHaveBeenCalledWith({ scope: "shared", id: "team" });
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("reuses the editor for revision checked authorization changes and pausing shared use", async () => {
    await mount(true); await click("管理共享配置");
    const checks = host.querySelectorAll<HTMLInputElement>("fieldset input[type=checkbox]");
    expect(checks).toHaveLength(3);
    await act(async () => { checks[0].click(); checks[2].click(); });
    await click("保存配置");
    expect(mocks.shared.update).toHaveBeenCalledWith("team", expect.objectContaining({ enabled: false, memberIds: ["member-a", "member-b"], revision: 4, apiKey: "****" }));
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("publishes a saved personal profile without copying its masked credentials through the client", async () => {
    await mount(true); await click("发布为共享配置");
    expect(mocks.shared.create).toHaveBeenCalledWith({ sourceProfileId: "personal", enabled: true, memberIds: [] });
    expect(host.querySelector("fieldset")).not.toBeNull();
    expect(host.textContent).toContain("已发布为独立共享配置");
  });

  it("tests shared settings through the saved shared endpoint without draft credential discovery", async () => {
    await mount(true); await click("管理共享配置"); await click("保存并测试共享配置");
    expect(mocks.shared.update).toHaveBeenCalled(); expect(mocks.shared.test).toHaveBeenCalledWith("team");
    expect(mocks.testDraft).not.toHaveBeenCalled(); expect(mocks.activateSelection).not.toHaveBeenCalled();
  });

  it("shows revoked selection explicitly while leaving personal configuration selectable", async () => {
    mocks.available.mockResolvedValue({ ...baseAvailable, sharedProfiles: [], unavailable: true, active: { scope: "shared", id: "team" } });
    await act(async () => root.render(<AISettingsPanel />));
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("当前共享配置不可用");
    expect(host.textContent).toContain("设为当前配置");
  });

  it("does not save or activate a tested draft under a different account (DCC-006)", async () => {
    let finish!: (value: {success: boolean}) => void;
    mocks.testDraft.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    await click("保存并测试");
    mocks.scope = "account-b";
    mocks.available.mockResolvedValue({ ...baseAvailable, personalProfiles: [], sharedProfiles: [] });
    await act(async () => { window.dispatchEvent(new Event("nowen:token-changed")); finish({ success: true }); });
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.activate).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Team AI");
  });
  it("shows remote directory errors while preserving local personal configuration", async () => {
    mocks.available.mockResolvedValue({ ...baseAvailable, sharedProfiles: [], remoteError: "远程共享服务不可达" });
    await act(async () => root.render(<AISettingsPanel />));
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("远程共享服务不可达");
    expect(host.textContent).toContain("Personal");
  });

  it("allows removing disabled recipients while preventing new grants to disabled accounts", async () => {
    mocks.shared.list.mockResolvedValue({ profiles: [managed], members: [{id: "member-a", username: "Alice", isDisabled: 1}, {id: "member-b", username: "Bob", isDisabled: 1}] });
    await mount(true); await click("管理共享配置");
    const checks = host.querySelectorAll<HTMLInputElement>("fieldset input[type=checkbox]");
    expect(host.querySelector("fieldset")!.textContent).toContain("Alice · 已停用");
    expect(checks[1].checked).toBe(true); expect(checks[1].disabled).toBe(false);
    expect(checks[2].checked).toBe(false); expect(checks[2].disabled).toBe(true);
    await act(async () => checks[1].click());
    expect(checks[1].checked).toBe(false); expect(checks[1].disabled).toBe(true);
    await click("保存配置");
    expect(mocks.shared.update).toHaveBeenCalledWith("team", expect.objectContaining({memberIds: []}));
  });

});
