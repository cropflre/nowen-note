import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRegisterConfig, getServerUrl, registerAccount, testServerConnection } from "@/lib/api";
import { inferBrowserServerBaseUrl } from "@/lib/serverUrl";
import LoginPage from "../LoginPage";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/useSiteSettings", () => ({
  useSiteSettings: () => ({ siteConfig: { title: "nowen-note", favicon: "", icpBeian: "" } }),
}));
vi.mock("@/hooks/useCapacitor", () => ({ useKeyboardLayout: () => {} }));
vi.mock("@/hooks/useKeyboardVisible", () => ({ useKeyboardVisible: () => ({ height: 0 }) }));
vi.mock("@/components/LanDiscoveryPanel", () => ({ default: () => null }));
vi.mock("@/lib/api", () => ({
  clearServerUrl: vi.fn(),
  fetchRegisterConfig: vi.fn(),
  getServerUrl: vi.fn(),
  registerAccount: vi.fn(),
  setServerUrl: vi.fn(),
  testServerConnection: vi.fn(),
}));

describe("Web 登录自动连接当前站点", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onLogin = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/notes/demo");
    Reflect.deleteProperty(window, "nowenDesktop");
    Reflect.deleteProperty(window, "Capacitor");
    vi.mocked(getServerUrl).mockImplementation(() => inferBrowserServerBaseUrl());
    vi.mocked(fetchRegisterConfig).mockResolvedValue({ allowRegistration: true, hasUsers: true } as unknown as { allowRegistration: boolean; });
    vi.mocked(registerAccount).mockResolvedValue({ token: "registered", refreshToken: "refresh", user: { username: "alice" } } as unknown as { token: string; refreshToken: string; user: import("@/types/index").User; });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ token: "token", user: { username: "alice" } }))));
    vi.stubGlobal("scrollTo", vi.fn());
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderPage() {
    await act(async () => root.render(<LoginPage onLogin={onLogin} />));
  }

  async function fill(selector: string, value: string) {
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
  }

  async function fillCredentials() {
    await fill('input[autocomplete="username"]', "alice");
    await fill('input[autocomplete="current-password"]', "secret-password");
  }

  it("笔记链接和旧服务器配置不会在 Web 登录页展示连接表单", async () => {
    localStorage.setItem("nowen-server-url", "https://old.example.com");
    await renderPage();
    expect(host.textContent).not.toContain("auth.serverAddress");
    expect(host.textContent).not.toContain("auth.resetServer");
    expect(host.textContent).not.toContain("auth.clientNote");
    expect(host.querySelector('input[inputmode="url"]')).toBeNull();
    await fillCredentials();
    await submit();
    expect(fetch).toHaveBeenCalledWith("/api/auth/login", expect.any(Object));
    expect(testServerConnection).not.toHaveBeenCalled();
    expect(onLogin).toHaveBeenCalledWith("token", expect.objectContaining({ username: "alice" }));
  });

  it("子路径部署的登录和二次验证使用同一个站点 API", async () => {
    window.history.replaceState(null, "", "/nowen/notes/demo");
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ requires2FA: true, ticket: "ticket" })));
    await renderPage();
    await fillCredentials();
    await submit();
    await fill('input[autocomplete="one-time-code"]', "123456");
    await submit();
    const base = `${window.location.origin}/nowen/api`;
    expect(fetch).toHaveBeenNthCalledWith(1, `${base}/auth/login`, expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(2, `${base}/auth/2fa/verify`, expect.objectContaining({
      body: expect.stringContaining('"ticket":"ticket"'),
    }));
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it("子路径部署的注册连接当前站点", async () => {
    window.history.replaceState(null, "", "/nowen/login");
    await renderPage();
    await act(async () => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "auth.registerTab")!.click());
    await fill('input[autocomplete="username"]', "alice");
    const passwords = host.querySelectorAll<HTMLInputElement>('input[autocomplete="new-password"]');
    await act(async () => {
      for (const input of passwords) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "secret-password");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await submit();
    expect(registerAccount).toHaveBeenCalledWith(expect.objectContaining({ username: "alice" }), `${window.location.origin}/nowen`);
    expect(onLogin).toHaveBeenCalledWith("registered", expect.any(Object));
  });

  it("服务不可用时提供简洁提示和重试，保留已填账号", async () => {
    await renderPage();
    await fillCredentials();
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("auth.serviceUnavailable");
    expect(host.textContent).not.toContain("auth.loginNoResponse");
    await act(async () => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "auth.retryConnection")!.click());
    expect(fetchRegisterConfig).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[autocomplete="username"]')?.value).toBe("alice");
    await submit();
    expect(onLogin).toHaveBeenCalledTimes(1);
  });

  it("初次连接失败也展示重试入口", async () => {
    vi.mocked(fetchRegisterConfig).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await renderPage();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("auth.serviceUnavailable");
    await act(async () => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "auth.retryConnection")!.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("HTTP 503 显示服务重试，HTTP 401 显示账号错误", async () => {
    await renderPage();
    await fillCredentials();
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("auth.serviceUnavailable");
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: "账号或密码错误" }), { status: 401 }));
    await submit();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("账号或密码错误");
    expect(host.textContent).not.toContain("auth.loginHttpError");
  });
});
