import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SyncSettingsTab from "../settings/SyncSettingsTab";
const mocks = vi.hoisted(() => ({ info: vi.fn(), diagnostics: vi.fn(), android: false, native: false }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => mocks.native } }));
vi.mock("@/lib/desktopBridge", () => ({ getAppInfo: mocks.info, getLiteMigrationProgress: vi.fn(), startLiteMigration: vi.fn() }));
vi.mock("@/lib/mobileLocalMode", () => ({ isAndroidNativeRuntime: () => mocks.android }));
vi.mock("@/lib/api", () => ({ getServerUrl: () => "https://notes.example.com" }));
vi.mock("@/lib/authSession", () => ({ getAccessToken: () => "token" }));
vi.mock("@/lib/syncLocalApi", () => ({
  fetchSyncDiagnostics: mocks.diagnostics, fetchSyncScopes: async () => ({ items: [] }),
  exportSyncScope: vi.fn(), copySyncScopeToPersonal: vi.fn(), SyncV2DisabledError: class extends Error {},
}));
vi.mock("../settings/SyncSettingsPanel", () => ({ SyncSettingsPanel: () => <span>客户端同步开关</span> }));
vi.mock("../settings/MobileSyncSettings", () => ({ default: () => <span>Android 同步开关</span> }));
vi.mock("../settings/ServerConnectionSettings", () => ({ default: () => <span>服务器连接</span> }));
vi.mock("../settings/ConflictCenter", () => ({ ConflictCenter: () => null }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks(); mocks.android = false; mocks.native = false; mocks.info.mockResolvedValue(null);
  mocks.diagnostics.mockResolvedValue({ deviceId: "device" });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const mount = async () => { await act(async () => root.render(<SyncSettingsTab />)); };
describe("sync settings across browser and clients", () => {
  it("explains direct server access in the browser instead of offering a false device-only switch", async () => {
    await mount();
    expect(host.textContent).toContain("浏览器直接操作服务器上的数据");
    expect(host.textContent).not.toContain("同步开关");
    expect(mocks.diagnostics).not.toHaveBeenCalled();
  });
  it("keeps desktop client sync settings", async () => {
    mocks.info.mockResolvedValue({ mode: "full", runtime: "local" });
    await mount(); expect(host.textContent).toContain("客户端同步开关");
  });
  it("keeps Android sync settings when there is no desktop bridge", async () => {
    mocks.android = true;
    await mount(); expect(host.textContent).toContain("Android 同步开关");
  });
  it("does not identify other native apps as a server browser", async () => {
    mocks.native = true;
    await mount(); expect(host.textContent).toContain("客户端同步开关");
  });
});
