import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MobileAccountSettings from "../settings/MobileAccountSettings";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";

const mocks = vi.hoisted(() => ({ switchAccount: vi.fn(), toastError: vi.fn(), reload: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/accountLoginSwitch", () => ({ switchAccountLogin: mocks.switchAccount }));
vi.mock("@/lib/toast", () => ({ toast: { error: mocks.toastError } }));
vi.mock("@/lib/api", () => ({
  getServerUrl: () => "https://current.example.com",
  setServerUrl: vi.fn(), testServerConnection: vi.fn(), broadcastLogout: vi.fn(),
}));
vi.mock("@/lib/accountLoginHistory", () => ({
  CURRENT_ACCOUNT_HISTORY_ID_KEY: "nowen-account-history-current-id",
  isAccountLoginHistorySupported: () => true,
  listAccountLoginHistory: async () => [
    { id: "current", username: "alice", displayName: "Alice", serverUrl: "https://current.example.com", lastUsedAt: 2 },
    { id: "target", username: "bob", displayName: "Bob", serverUrl: "https://other.example.com", lastUsedAt: 1 },
  ],
  removeAccountLoginHistory: vi.fn(), updateAccountLoginHistoryServerUrl: vi.fn(),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root, host: HTMLElement;
const button = (label: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === label)!;
const mount = async () => { await act(async () => root.render(<MobileAccountSettings accountLabel="Alice" />)); };
const openSwitcher = async () => { await act(async () => button("mobileAccount.switchAccount").click()); };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem("nowen-token", "current-token");
  localStorage.setItem("nowen-account-history-current-id", "current");
  Object.assign(window, { Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" } });
  const realWindow = window;
  vi.stubGlobal("window", new Proxy(realWindow, {
    get: (target, key) => key === "location" ? { reload: mocks.reload } : Reflect.get(target, key, target),
  }));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  vi.unstubAllGlobals(); Reflect.deleteProperty(window, "Capacitor");
});

describe("手机设置切换账号", () => {
  it("提供明确入口，展示账号与服务器并标记当前账号", async () => {
    await mount(); await openSwitcher();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-label")).toBe("auth.loginHistory.title");
    expect(dialog?.parentElement).toBe(document.body);
    expect(dialog?.textContent).toContain("other.example.com");
    expect(dialog?.textContent).toContain("auth.loginHistory.addAccount");
    const current = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Alicecommon.current"));
    expect(current?.disabled).toBe(true);
  });

  it("切换中保留加载状态，连接失败后保留弹层和当前会话，允许重试", async () => {
    let finish!: (value: unknown) => void;
    mocks.switchAccount.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await mount(); await openSwitcher();
    const target = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Bob"))!;
    await act(async () => target.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(target.disabled).toBe(true);
    expect(button("auth.loginHistory.addAccount").disabled).toBe(true);
    await act(async () => finish({ status: "network_error", message: "连接失败" }));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(target.disabled).toBe(false);
    expect(localStorage.getItem("nowen-token")).toBe("current-token");
    expect(mocks.toastError).toHaveBeenCalledWith("连接失败");
    expect(mocks.reload).not.toHaveBeenCalled();
    mocks.switchAccount.mockResolvedValueOnce({ status: "switched", token: "target-token", user: { id: "bob", username: "bob" } });
    await act(async () => target.click());
    expect(mocks.switchAccount).toHaveBeenCalledTimes(2);
    expect(mocks.reload).toHaveBeenCalledOnce();
  });

  it("添加账号进入主动登录模式并保留本机数据", async () => {
    localStorage.setItem("local-note-marker", "keep");
    await mount(); await openSwitcher();
    await act(async () => button("auth.loginHistory.addAccount").click());
    expect(localStorage.getItem("nowen-token")).toBeNull();
    expect(isMobileLocalMode()).toBe(false);
    expect(localStorage.getItem("nowen-mobile-account-login-requested")).toBe("1");
    expect(localStorage.getItem("local-note-marker")).toBe("keep");
    expect(mocks.reload).toHaveBeenCalledOnce();
  });

  it("未登录本机模式仍提供登录入口", async () => {
    localStorage.removeItem("nowen-token");
    await mount();
    expect(host.textContent).toContain("mobileAccount.signInAndSync");
    expect(host.textContent).not.toContain("mobileAccount.switchAccount");
  });
});
