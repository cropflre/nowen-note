import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MobileSyncSettings from "../settings/MobileSyncSettings";
import i18n from "@/i18n";
const mocks = vi.hoisted(() => ({ settings: vi.fn(), disable: vi.fn(), connect: vi.fn(), diagnostics: vi.fn() }));
vi.mock("@/lib/syncLocalApi", () => ({
  fetchSyncSettings: mocks.settings, disableSync: mocks.disable, connectSyncServer: mocks.connect,
  fetchSyncDiagnostics: mocks.diagnostics, triggerSyncNow: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ getServerUrl: () => "https://notes.example.com" }));
vi.mock("@/lib/mobileLocalMode", () => ({ isMobileLocalMode: () => false, requestMobileAccountLogin: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLElement;
let mode: "server" | "device-only";
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  vi.clearAllMocks(); mode = "server";
  mocks.settings.mockImplementation(async () => ({
    mode, authorized: true, profiles: [{ serverUrl: "https://notes.example.com" }],
    activeProfile: mode === "server" ? { serverUrl: "https://notes.example.com" } : null,
  }));
  mocks.disable.mockImplementation(async () => { mode = "device-only"; });
  mocks.connect.mockImplementation(async () => { mode = "server"; });
  mocks.diagnostics.mockResolvedValue({ pendingMutations: 0, pendingAttachments: 0, lastSyncAt: null });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const mount = async () => { await act(async () => root.render(<MobileSyncSettings />)); };
const choices = () => host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
describe("Android simple sync choices", () => {
  it("updates mounted mobile sync labels when switching between Chinese and English", async () => {
    await mount();
    expect(host.textContent).toContain("不同步，仅此设备");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(host.textContent).toContain("This device only (no sync)");
    expect(host.textContent).toContain("Sync now");
    expect(host.textContent).not.toContain("不同步，仅此设备");
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(host.textContent).toContain("不同步，仅此设备");
  });

  it("turns sync off and on using the same account, without switching data spaces", async () => {
    await mount();
    expect(choices()).toHaveLength(2);
    expect(choices()[1].checked).toBe(true);
    expect(host.textContent).not.toContain("存储模式");
    await act(async () => choices()[0].click());
    expect(mocks.disable).toHaveBeenCalledOnce();
    expect(choices()[0].checked).toBe(true);
    expect(host.textContent).not.toContain("已连接 https://");
    expect(host.textContent).not.toContain("立即同步");
    await act(async () => choices()[1].click());
    expect(mocks.connect).toHaveBeenCalledWith({ serverUrl: "https://notes.example.com" });
    expect(choices()[1].checked).toBe(true);
    expect(host.textContent).toContain("已连接 https://notes.example.com");
  });
  it("does not show disabled or enabled successfully when changing the mode fails", async () => {
    await mount();
    mocks.disable.mockRejectedValueOnce(new Error("database unavailable"));
    await act(async () => choices()[0].click());
    expect(choices()[1].checked).toBe(true);
    expect(host.textContent).toContain("未能更改同步设置");
  });
  it("does not claim sync is off when settings cannot be read", async () => {
    mocks.settings.mockRejectedValueOnce(new Error("database unavailable"));
    await mount();
    expect(choices()).toHaveLength(0);
    expect(host.textContent).toContain("暂时无法读取同步设置");
  });
});
