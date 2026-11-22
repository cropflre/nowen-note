import React, { act } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverNowenApiPath, resolveWebSocketPathAfterLogin, setServerUrl } from "@/lib/api";
import LoginPage from "../LoginPage";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { localHint, completeLocalLoginHint } = vi.hoisted(() => ({
  localHint: {
    serverUrl: "http://127.0.0.1:43127",
    username: "desktop",
    password: "local-secret-password",
    role: "admin" as const,
  },
  completeLocalLoginHint: vi.fn(async () => ({ ok: true })),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => options
    ? `${key} ${options.target || ""} ${options.reason || ""} ${options.date || ""}`
    : key }),
}));

vi.mock("@/hooks/useSiteSettings", () => ({
  useSiteSettings: () => ({
    siteConfig: { title: "nowen-note", favicon: "", icpBeian: "", editorFontFamily: "" },
  }),
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
vi.mock("@/lib/ugreenRemoteAccess", () => ({
  isUgreenRemoteAccessUrl: () => false,
  openUgreenRemoteWorkspace: vi.fn(),
}));
vi.mock("@/lib/desktopBridge", () => ({
  getDesktopLocalLoginHint: vi.fn(async () => localHint),
  completeDesktopLocalLoginHint: completeLocalLoginHint,
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

async function waitFor(assertion: () => void) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 1000) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

describe("桌面端本地登录信息提示", () => {
  let root: Root | null = null;

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    completeLocalLoginHint.mockClear();
    vi.mocked(discoverNowenApiPath).mockReset().mockResolvedValue(null);
    vi.mocked(resolveWebSocketPathAfterLogin).mockReset().mockResolvedValue(true);
    vi.mocked(setServerUrl).mockClear();
    Object.assign(window, { nowenDesktop: { isDesktop: true } });
    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      token: "token-local",
      refreshToken: "refresh-local",
      user: { id: "user-local", username: "desktop" },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    Reflect.deleteProperty(window, "nowenDesktop");
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("展示地址账号密码，一键填入并在登录成功后隐藏", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const onLogin = vi.fn();

    await act(async () => {
      root?.render(<LoginPage isClientMode onLogin={onLogin} />);
    });

    await waitFor(() => {
      expect(host.textContent).toContain(localHint.serverUrl);
      expect(host.textContent).toContain(localHint.username);
      expect(host.textContent).toContain(localHint.password);
    });

    const fillButton = Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "auth.localDesktopLogin.fillButton");
    await act(async () => fillButton?.click());

    expect(host.querySelector<HTMLInputElement>('input[autocomplete="username"]')?.value).toBe(localHint.username);
    expect(host.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')?.value).toBe(localHint.password);

    await act(async () => {
      host.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await waitFor(() => {
      expect(completeLocalLoginHint).toHaveBeenCalledWith(localHint.serverUrl, localHint.username);
      expect(onLogin).toHaveBeenCalledWith("token-local", expect.objectContaining({ username: "desktop" }));
      expect(host.querySelector("[data-desktop-local-login-hint]")).toBeNull();
    });
  });

  async function renderWithLocalHint(onLogin = vi.fn()) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<LoginPage isClientMode onLogin={onLogin} />));
    await waitFor(() => expect(host.textContent).toContain(localHint.serverUrl));
    await act(async () => Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "auth.localDesktopLogin.fillButton")?.click());
    return host;
  }

  async function submit(host: HTMLElement) {
    await act(async () => host.querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  }

  it("登录前不做 /health 或 WebSocket 探测，登录接口正常即进入工作台", async () => {
    const onLogin = vi.fn();
    const host = await renderWithLocalHint(onLogin);
    vi.mocked(setServerUrl).mockClear();
    await submit(host);
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith("token-local", expect.objectContaining({ username: "desktop" })));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`${localHint.serverUrl}/api/auth/login`, expect.objectContaining({ method: "POST", redirect: "manual" }));
    expect(discoverNowenApiPath).not.toHaveBeenCalled();
    // WebSocket 在登录后后台确认，不阻塞进入工作台。
    expect(resolveWebSocketPathAfterLogin).toHaveBeenCalledWith(localHint.serverUrl);
    expect(setServerUrl).toHaveBeenCalledWith(localHint.serverUrl);
  });

  it("WebSocket 后台确认失败时仍进入工作台", async () => {
    vi.mocked(resolveWebSocketPathAfterLogin).mockResolvedValue(false);
    const onLogin = vi.fn();
    const host = await renderWithLocalHint(onLogin);
    vi.mocked(setServerUrl).mockClear();
    await submit(host);
    await waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("区分连续无 HTTP 响应与 Nowen 返回的密码错误", async () => {
    const host = await renderWithLocalHint();
    vi.mocked(setServerUrl).mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await submit(host);
      await waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("auth.serverUnreachable"));
      // 只自动补发一次，补发仍无响应才提示；不显示地址、状态码等技术细节。
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[role="alert"]')?.textContent).not.toContain(localHint.serverUrl);
      expect(Array.from(host.querySelectorAll('[role="alert"] button')).map((button) => button.textContent)).toEqual(["auth.retryConnection"]);

      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "用户名或密码错误" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })));
      await submit(host);
      await waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("auth.invalidCredentials"));
      // 服务端已给出 Nowen 响应时不重发、不探测其他路径。
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(discoverNowenApiPath).not.toHaveBeenCalled();
      expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
      expect(host.querySelector('[role="alert"] button')).toBeNull();
    } finally {
      warnLog.mockRestore();
    }
  });

  it("登录请求第一次没有 HTTP 响应时自动补发一次，用户不必再点", async () => {
    const onLogin = vi.fn();
    const host = await renderWithLocalHint(onLogin);
    vi.mocked(setServerUrl).mockClear();
    vi.stubGlobal("fetch", vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: "token-after-retry",
        user: { id: "user-local", username: "desktop" },
      }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await submit(host);
      await waitFor(() => expect(onLogin).toHaveBeenCalledWith("token-after-retry", expect.objectContaining({ username: "desktop" })));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    } finally {
      warnLog.mockRestore();
    }
  });

  it("重试按钮重新提交同一账号", async () => {
    const onLogin = vi.fn();
    const host = await renderWithLocalHint(onLogin);
    vi.mocked(setServerUrl).mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } })));
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await submit(host);
      await waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("auth.serverUnreachable"));
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        token: "token-retry", user: { id: "user-local", username: "desktop" },
      }), { status: 200, headers: { "Content-Type": "application/json" } })));
      await act(async () => host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
      await waitFor(() => expect(onLogin).toHaveBeenCalledWith("token-retry", expect.any(Object)));
    } finally {
      warnLog.mockRestore();
    }
  });

  it("代理返回 200 HTML 时不判为成功，确认同一入口下的兼容路径后再提交", async () => {
    const onLogin = vi.fn();
    const host = await renderWithLocalHint(onLogin);
    vi.mocked(setServerUrl).mockClear();
    vi.mocked(discoverNowenApiPath).mockResolvedValueOnce({
      mode: "public-prefix",
      serverBaseUrl: localHint.serverUrl,
      apiBaseUrl: `${localHint.serverUrl}/public/api`,
      apiPath: "/public/api",
      websocketUrl: "ws://127.0.0.1:43127/public/ws",
      websocketPath: "/public/ws",
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("<!doctype html><title>Lucky</title>", { status: 200, headers: { "Content-Type": "text/html" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: "token-lucky", user: { id: "user-local", username: "desktop" },
      }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await submit(host);
      await waitFor(() => expect(onLogin).toHaveBeenCalledWith("token-lucky", expect.any(Object)));
      expect(discoverNowenApiPath).toHaveBeenCalledWith(localHint.serverUrl, `${localHint.serverUrl}/api`);
      expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
        `${localHint.serverUrl}/api/auth/login`,
        `${localHint.serverUrl}/public/api/auth/login`,
      ]);
    } finally {
      warnLog.mockRestore();
    }
  });

  it("代理返回 200 HTML 且找不到 Nowen 路径时提示连接失败，不进入工作台", async () => {
    const onLogin = vi.fn();
    const host = await renderWithLocalHint(onLogin);
    vi.mocked(setServerUrl).mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body>home</body></html>", { status: 200, headers: { "Content-Type": "text/html" } })));
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await submit(host);
      await waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("auth.serverUnreachable"));
      expect(onLogin).not.toHaveBeenCalled();
      expect(localStorage.getItem("nowen-token")).toBeNull();
      expect(setServerUrl).not.toHaveBeenCalled();
    } finally {
      warnLog.mockRestore();
    }
  });

  it.each([
    ["跳转", () => new Response(null, { status: 302, headers: { Location: "https://auth.example.com/login" } })],
    ["代理登录页", () => new Response('<form><input type="password" name="pwd"></form>', { status: 200, headers: { "Content-Type": "text/html" } })],
    ["Basic 认证", () => new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Basic realm=gw" } })],
  ])("代理网关%s要求交互验证时提供打开原地址的入口", async (_label, response) => {
    const host = await renderWithLocalHint();
    vi.mocked(setServerUrl).mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await submit(host);
      await waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("auth.gatewayVerificationRequired"));
      expect(fetch).toHaveBeenCalledTimes(1);
      const button = host.querySelector<HTMLButtonElement>('[role="alert"] button')!;
      expect(button.textContent).toBe("auth.openInBrowser");
      await act(async () => button.click());
      expect(open).toHaveBeenCalledWith(localHint.serverUrl, "_blank", "noopener,noreferrer");
    } finally {
      open.mockRestore();
      warnLog.mockRestore();
    }
  });

  it("真实两步验证挑战进入验证码步骤，不先保存服务器或令牌", async () => {
    const onLogin = vi.fn();
    const host = await renderWithLocalHint(onLogin);
    vi.mocked(setServerUrl).mockClear();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ requires2FA: true, ticket: "ticket-1", username: "desktop" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "token-2fa", user: { id: "user-local", username: "desktop" } }), { status: 200 })));
    await submit(host);
    await waitFor(() => expect(host.querySelector('input[autocomplete="one-time-code"]')).not.toBeNull());
    expect(setServerUrl).not.toHaveBeenCalled();
    expect(localStorage.getItem("nowen-token")).toBeNull();
    const code = host.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(code, "123456");
      code.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await submit(host);
    await waitFor(() => expect(onLogin).toHaveBeenCalledWith("token-2fa", expect.any(Object)));
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe(`${localHint.serverUrl}/api/auth/2fa/verify`);
    expect(setServerUrl).toHaveBeenCalledWith(localHint.serverUrl);
  });

  it("连续提交只发出一个登录请求", async () => {
    const host = await renderWithLocalHint();
    vi.mocked(setServerUrl).mockClear();
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    await submit(host);
    await submit(host);
    await submit(host);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(host.querySelector('button[type="submit"]')?.textContent).toContain("auth.signingIn");
    await act(async () => finish(new Response(JSON.stringify({ error: "用户名或密码错误" }), { status: 401 })));
    await waitFor(() => expect(host.textContent).toContain("auth.invalidCredentials"));
  });

  it("主表单不再显示探测结果、重新检测入口或明文提示", async () => {
    const host = await renderWithLocalHint();
    vi.mocked(setServerUrl).mockClear();
    expect(host.textContent).not.toContain("auth.recheckConnection");
    expect(host.textContent).not.toContain("server.connectionDiagnostics");
    expect(host.querySelector("[data-insecure-connection-notice]")).toBeNull();
    expect(host.querySelector('[aria-haspopup="listbox"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="server.addressLabel"]')?.value).toBe(localHint.serverUrl);
  });

  it("登录页高度用类声明，旧 WebView 不支持 dvh 时由 index.css 回退到 vh，页面仍可滚动", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<LoginPage isClientMode onLogin={vi.fn()} />));
    const container = host.firstElementChild as HTMLElement;
    expect(container.className).toContain("overflow-y-auto");
    expect(container.className).toContain("min-h-[100dvh]");
    expect(container.className).toContain("max-h-[100dvh]");
    // 内联 dvh 在旧 WebView 中会被整条丢弃，回退规则也匹配不到。
    expect(container.getAttribute("style") || "").not.toContain("dvh");

    const css = readFileSync(path.join(process.cwd(), "src/index.css"), "utf8");
    const start = css.indexOf("@supports not (height: 100dvh)");
    const fallback = css.slice(start, css.indexOf("@supports", start + 1));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(fallback).toContain(".min-h-\\[100dvh\\] { min-height: 100vh !important; }");
    expect(fallback).toContain(".max-h-\\[100dvh\\] { max-height: 100vh !important; }");
  });

  it("保留设备本地入口", async () => {
    const onContinueLocal = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<LoginPage isClientMode onLogin={vi.fn()} onContinueLocal={onContinueLocal} />));
    await act(async () => Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "auth.continueLocal")?.click());
    expect(onContinueLocal).toHaveBeenCalledTimes(1);
  });
  it("DCC-006: failed login to another server keeps the current server and session", async () => {
    localStorage.setItem("nowen-token", "previous-access-token");
    localStorage.setItem("nowen-refresh-token", "previous-refresh-token");
    const onLogin = vi.fn();
    const host = await renderWithLocalHint(onLogin);
    vi.mocked(setServerUrl).mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "用户名或密码错误" }), { status: 401 })));
    await submit(host);
    await waitFor(() => expect(host.textContent).toContain("auth.invalidCredentials"));
    expect(onLogin).not.toHaveBeenCalled();
    expect(setServerUrl).not.toHaveBeenCalled();
    expect(localStorage.getItem("nowen-token")).toBe("previous-access-token");
    expect(localStorage.getItem("nowen-refresh-token")).toBe("previous-refresh-token");
  });
});
