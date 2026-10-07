import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NavRail from "../NavRail";
import { DEFAULT_USER_PREFERENCES } from "@/lib/userPreferenceAccountCache";
import { enterMobileLocalMode } from "@/lib/mobileLocalMode";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: { viewMode: "notes", sidebarCollapsed: false } }),
  useAppActions: () => ({}),
}));
vi.mock("@/hooks/useUserPreferences", () => ({ useUserPreferences: () => ({ prefs: DEFAULT_USER_PREFERENCES }) }));
vi.mock("@/hooks/useRailMode", () => ({ useRailMode: () => ["label"] }));
vi.mock("@/hooks/useSidebarTextStyle", () => ({ useSidebarTextStyle: () => ["classic"] }));
vi.mock("@/hooks/useMobileRailHidden", () => ({ useMobileRailHidden: () => [false, vi.fn()] }));
vi.mock("@/lib/api", () => ({
  api: {}, broadcastLogout: vi.fn(), clearServerUrl: vi.fn(),
  getCurrentWorkspace: () => "personal", getServerUrl: () => "https://server",
}));
vi.mock("@/lib/desktopBridge", () => ({
  isDesktop: () => false, getAppInfo: vi.fn(), getDiagnosticsInfo: vi.fn(), clearDesktopLocalAuth: vi.fn(), switchDesktopToFull: vi.fn(),
}));
vi.mock("@/lib/offlineQueue", () => ({ clearQueue: vi.fn(), clearLocalIdMap: vi.fn(), getQueueLength: () => 0 }));
vi.mock("@/lib/accountLoginHistory", () => ({ isAccountLoginHistorySupported: () => true }));
vi.mock("@/components/AccountLoginHistory", () => ({ AccountLoginHistoryDialog: () => null }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLElement;
const render = async () => { await act(async () => root.render(<NavRail variant="mobile" />)); };
beforeEach(() => {
  localStorage.clear(); localStorage.setItem("nowen-token", "token");
  Object.assign(window, { Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); Reflect.deleteProperty(window,"Capacitor"); });
describe("Android rail account actions", () => {
  it.each(["account", "device"] as const)("leaves Settings as the last utility action in %s mode", async (mode) => {
    if (mode === "device") enterMobileLocalMode();
    await render();
    const labels = [...host.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
    expect(labels.at(-1)).toBe("sidebar.settings");
    expect(labels).not.toContain("sidebar.logout");
    expect(labels).not.toContain("sidebar.loginAndSync");
    expect(labels).not.toContain("auth.loginHistory.title");
    expect(labels).not.toContain("sidebar.switchToLocal");
  });
  it("preserves the web account history and logout actions", async () => {
    Reflect.deleteProperty(window, "Capacitor"); await render();
    expect(host.querySelector('[aria-label="sidebar.logout"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="auth.loginHistory.title"]')).not.toBeNull();
  });
});
