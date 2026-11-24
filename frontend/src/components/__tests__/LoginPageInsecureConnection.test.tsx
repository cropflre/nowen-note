import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "../LoginPage";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/useSiteSettings", () => ({
  useSiteSettings: () => ({ siteConfig: { title: "nowen-note", favicon: "", icpBeian: "" } }),
}));
vi.mock("@/hooks/useCapacitor", () => ({ useKeyboardLayout: () => {} }));
vi.mock("@/hooks/useKeyboardVisible", () => ({ useKeyboardVisible: () => ({ height: 0 }) }));
vi.mock("@/components/AccountLoginHistory", () => ({ AccountLoginHistoryList: () => null }));
vi.mock("@/lib/accountLoginHistory", () => ({ consumePendingAccountReauth: () => null }));
vi.mock("@/lib/rememberLogin", () => ({
  canPersistPassword: vi.fn(async () => false),
  loadRememberedCredentials: vi.fn(async () => null),
  saveRememberedCredentials: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/desktopBridge", () => ({
  getDesktopLocalLoginHint: vi.fn(async () => null),
  completeDesktopLocalLoginHint: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/api", () => ({
  clearServerUrl: vi.fn(),
  fetchRegisterConfig: vi.fn(async () => ({ allowRegistration: true, hasUsers: true })),
  getServerUrl: vi.fn(() => ""),
  registerAccount: vi.fn(),
  setServerUrl: vi.fn(),
  discoverNowenApiPath: vi.fn(async () => null),
  resolveWebSocketPathAfterLogin: vi.fn(async () => true),
}));

const DEFAULT_PAGE_URL = "http://localhost:3000/";

/** vitest 的 jsdom 环境把 JSDOM 实例挂在全局，用它切换页面来源。 */
function setPageUrl(url: string) {
  (globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }).jsdom.reconfigure({ url });
}

describe("已在使用的 HTTP 地址照常登录", () => {
  let host: HTMLDivElement;
  let root: Root;
  const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");

  beforeEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(window, "nowenDesktop");
    Reflect.deleteProperty(window, "Capacitor");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ token: "token", user: { id: "u1", username: "alice" } }))));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setPageUrl(DEFAULT_PAGE_URL);
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  });

  async function renderPage(onLogin = vi.fn(), isClientMode = false) {
    await act(async () => root.render(<LoginPage onLogin={onLogin} isClientMode={isClientMode} />));
  }

  async function type(selector: string, value: string) {
    const input = host.querySelector<HTMLInputElement>(selector)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function submit() {
    await act(async () => {
      host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    // 等提交流程结束（首次动态加载设备 ID 模块需要几个事件循环）。
    for (let i = 0; i < 100 && host.querySelector("button[type=submit]")?.textContent === "auth.signingIn"; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
  }

  it("网页通过局域网 HTTP 打开时不显示明文提示，直接登录", async () => {
    setPageUrl("http://192.168.1.10:3001/login");
    const onLogin = vi.fn();
    const confirm = vi.spyOn(window, "confirm");
    await renderPage(onLogin);
    expect(host.querySelector("[data-insecure-connection-notice]")).toBeNull();
    expect(host.textContent).not.toContain("auth.insecureConnection");
    await type('input[autocomplete="username"]', "alice");
    await type('input[autocomplete="current-password"]', "secret");
    await submit();
    expect(confirm).not.toHaveBeenCalled();
    expect(onLogin).toHaveBeenCalledWith("token", expect.objectContaining({ username: "alice" }));
  });

  it.each([
    ["192.168.1.10:3001", "http://192.168.1.10:3001/api/auth/login"],
    ["http://notes.example.com:8080/nowen", "http://notes.example.com:8080/nowen/api/auth/login"],
    ["nas:5000", "http://nas:5000/api/auth/login"],
  ])("客户端填写 %s 时按原协议直接登录，不弹确认", async (address, loginUrl) => {
    const onLogin = vi.fn();
    const confirm = vi.spyOn(window, "confirm");
    await renderPage(onLogin, true);
    await type('input[aria-label="server.addressLabel"]', address);
    expect(host.querySelector("[data-insecure-connection-notice]")).toBeNull();
    await type('input[autocomplete="username"]', "alice");
    await type('input[autocomplete="current-password"]', "secret");
    await submit();
    expect(confirm).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(loginUrl, expect.objectContaining({ method: "POST" }));
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it("客户端新输入的裸公网域名优先按 HTTPS 登录", async () => {
    await renderPage(vi.fn(), true);
    await type('input[aria-label="server.addressLabel"]', "notes.example.com");
    await type('input[autocomplete="username"]', "alice");
    await type('input[autocomplete="current-password"]', "secret");
    await submit();
    expect(fetch).toHaveBeenCalledWith("https://notes.example.com/api/auth/login", expect.any(Object));
  });

  it("客户端地址无效时提示检查服务器地址", async () => {
    await renderPage(vi.fn(), true);
    await type('input[autocomplete="username"]', "alice");
    await type('input[autocomplete="current-password"]', "secret");
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("auth.serverAddressInvalid");
    expect(fetch).not.toHaveBeenCalled();
  });
});
