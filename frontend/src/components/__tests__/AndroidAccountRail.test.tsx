import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NavRail from "../NavRail";
import { DEFAULT_USER_PREFERENCES } from "@/lib/userPreferenceAccountCache";
import { broadcastLogout } from "@/lib/api";

const mocks = vi.hoisted(() => ({ reload: vi.fn() }));

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
vi.mock("@/components/AccountLoginHistory", () => ({
  AccountLoginHistoryDialog: ({ open, onClose }: { open: boolean; onClose: () => void }) => open
    ? <div role="dialog" aria-label="auth.loginHistory.title"><button onClick={onClose}>close</button></div> : null,
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLElement;
const render = async (variant: "desktop" | "mobile" = "mobile") => { await act(async () => root.render(<NavRail variant={variant} />)); };
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); localStorage.setItem("nowen-token", "token");
  Object.assign(window, { Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" } });
  const realWindow = window;
  vi.stubGlobal("window", new Proxy(realWindow, {
    get: (target, key) => key === "location" ? { origin: "http://localhost", reload: mocks.reload } : Reflect.get(target, key, target),
  }));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); Reflect.deleteProperty(window,"Capacitor"); });
describe("Android rail account actions", () => {
  it("shows the desktop utility order in signed-in Android mode", async () => {
    await render();
    const labels = [...host.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
    expect(labels.slice(-4)).toEqual([
      "sidebar.settings", "auth.loginHistory.title", "sidebar.switchToLocal", "sidebar.logout",
    ]);
    expect(labels).not.toContain("sidebar.loginAndSync");
  });
  it("opens and closes the same account dialog from mobile and desktop rails", async () => {
    for (const variant of ["mobile", "desktop"] as const) {
      await render(variant);
      const account = host.querySelector<HTMLButtonElement>('[aria-label="auth.loginHistory.title"]')!;
      expect(account.textContent).toBe("auth.loginHistory.shortTitle");
      await act(async () => account.click());
      expect(host.querySelector('[role="dialog"]')).not.toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click());
      expect(host.querySelector('[role="dialog"]')).toBeNull();
    }
  });
  it("preserves the signed-in token when entering the device space and exposes sign-in there", async () => {
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="sidebar.switchToLocal"]')!.click());
    expect(localStorage.getItem("nowen-token")).toBe("token");
    await render();
    const labels = [...host.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
    expect(labels.slice(-2)).toEqual(["sidebar.settings", "sidebar.loginAndSync"]);
    expect(labels).not.toContain("sidebar.logout");
    expect(labels).not.toContain("auth.loginHistory.title");
    expect(labels).not.toContain("sidebar.switchToLocal");
  });
  it("preserves the web account history and logout actions", async () => {
    Reflect.deleteProperty(window, "Capacitor"); await render();
    expect(host.querySelector('[aria-label="sidebar.logout"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="auth.loginHistory.title"]')).not.toBeNull();
  });
  it("Android sign-out requests the login screen instead of falling back to the device space", async () => {
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="sidebar.logout"]')!.click());
    expect(broadcastLogout).toHaveBeenCalledWith("user_logout");
    expect(localStorage.getItem("nowen-mobile-account-login-requested")).toBe("1");
    expect(mocks.reload).toHaveBeenCalledOnce();
  });
});
