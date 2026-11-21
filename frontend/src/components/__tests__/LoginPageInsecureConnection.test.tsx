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
  testServerConnection: vi.fn(async () => ({ ok: true })),
}));

const NOTICE = "[data-insecure-connection-notice]";
const DEFAULT_PAGE_URL = "http://localhost:3000/";

/** vitest 的 jsdom 环境把 JSDOM 实例挂在全局，用它切换页面来源。 */
function setPageUrl(url: string) {
  (globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }).jsdom.reconfigure({ url });
}

describe("登录页明文 HTTP 提示", () => {
  let host: HTMLDivElement;
  let root: Root;
  const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");

  beforeEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(window, "nowenDesktop");
    Reflect.deleteProperty(window, "Capacitor");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setPageUrl(DEFAULT_PAGE_URL);
    vi.clearAllMocks();
    if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  });

  async function renderPage(isClientMode = false) {
    await act(async () => root.render(<LoginPage onLogin={vi.fn()} isClientMode={isClientMode} />));
  }

  async function typeServerAddress(value: string) {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="server.addressLabel"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("网页通过局域网 HTTP 打开时提示未加密，并链接 HTTPS 配置说明", async () => {
    setPageUrl("http://192.168.1.10:3001/login");
    await renderPage();
    const notice = host.querySelector(NOTICE);
    expect(notice?.textContent).toContain("auth.insecureConnection");
    const link = notice?.querySelector("a");
    expect(link?.textContent).toBe("auth.insecureConnectionGuide");
    expect(link?.getAttribute("href")).toBe("https://github.com/cropflre/nowen-note/blob/main/docs/https-deployment.md");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it.each([
    "https://note.example.com/login",
    "http://localhost:5173/",
    "http://127.0.0.1:3001/",
    "http://[::1]:3001/",
  ])("网页地址 %s 不提示", async (url) => {
    setPageUrl(url);
    await renderPage();
    expect(host.querySelector(NOTICE)).toBeNull();
  });

  it("客户端填写局域网 HTTP 地址时提示，切换到 HTTPS 后消失", async () => {
    await renderPage(true);
    expect(host.querySelector(NOTICE)).toBeNull();

    await typeServerAddress("192.168.1.10:3001");
    expect(host.querySelector(NOTICE)?.textContent).toContain("auth.insecureConnection");

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="server.protocolLabel"]')!.click());
    await act(async () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((option) => option.textContent === "https://")!.click());
    expect(host.querySelector(NOTICE)).toBeNull();
  });

  it("客户端连接本机 HTTP 服务时不提示", async () => {
    await renderPage(true);
    await typeServerAddress("127.0.0.1:3001");
    expect(host.querySelector(NOTICE)).toBeNull();
  });
});
