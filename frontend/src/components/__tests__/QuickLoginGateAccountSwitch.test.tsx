import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuickLoginGate from "../QuickLoginGate";
import { requestMobileAccountLogin } from "@/lib/mobileLocalMode";

const mocks = vi.hoisted(() => ({ attempt: vi.fn(), enabled: vi.fn() }));
vi.mock("@/lib/quickLogin", () => ({
  isQuickLoginPlatformSupported: () => true,
  isQuickLoginEnabled: mocks.enabled,
  attemptQuickLogin: mocks.attempt,
  disableQuickLogin: vi.fn(), getQuickLoginUsername: async () => "Alice",
}));
vi.mock("@/lib/api", () => ({ setServerUrl: vi.fn(), getServerUrl: () => "https://notes.example.com" }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, host: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
  mocks.enabled.mockResolvedValue(true);
  mocks.attempt.mockResolvedValue({ ok: false });
  Object.assign(window, { Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); Reflect.deleteProperty(window, "Capacitor"); });

describe("主动切换账号时的快速登录", () => {
  it("主动登录其他账号时跳过旧账号生物识别", async () => {
    requestMobileAccountLogin();
    const settled = vi.fn();
    await act(async () => root.render(<QuickLoginGate isClientMode onSettled={settled} />));
    expect(settled).toHaveBeenCalledWith(false);
    expect(mocks.attempt).not.toHaveBeenCalled();
  });

  it("正常启动仍尝试生物识别登录", async () => {
    await act(async () => root.render(<QuickLoginGate isClientMode onSettled={vi.fn()} />));
    expect(mocks.attempt).toHaveBeenCalledOnce();
  });
});
