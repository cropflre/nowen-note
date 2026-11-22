import React, { act } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testServerConnection } from "@/lib/api";
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
  testServerConnection: vi.fn(async () => ({ ok: true })),
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
    vi.mocked(testServerConnection).mockReset().mockResolvedValue({ ok: true });
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

  it("连接探测失败时不会误报为密码错误", async () => {
    vi.mocked(testServerConnection).mockResolvedValueOnce({ ok: false, error: "Failed to fetch" });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<LoginPage isClientMode onLogin={vi.fn()} />));
    await waitFor(() => expect(host.textContent).toContain(localHint.serverUrl));
    await act(async () => {
      Array.from(host.querySelectorAll("button"))
        .find((button) => button.textContent === "auth.localDesktopLogin.fillButton")?.click();
      host.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(host.textContent).toContain("auth.serverProbeFailed"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("区分登录请求无 HTTP 响应与服务端返回 401", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<LoginPage isClientMode onLogin={vi.fn()} />));
    await waitFor(() => expect(host.textContent).toContain(localHint.serverUrl));
    await act(async () => Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "auth.localDesktopLogin.fillButton")?.click());

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await act(async () => host.querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      await waitFor(() => expect(host.textContent).toContain("auth.loginNoResponse"));
      // 只自动补发一次，补发仍无响应才提示。
      expect(fetch).toHaveBeenCalledTimes(2);

      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "wrong password" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })));
      await act(async () => host.querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      await waitFor(() => expect(host.textContent).toContain("auth.loginHttpError"));
      // 服务端已给出 HTTP 响应（含密码错误）时不重发。
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
      warnLog.mockRestore();
    }
  });

  it("登录请求第一次没有 HTTP 响应时自动补发一次，用户不必再点", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const onLogin = vi.fn();
    await act(async () => root?.render(<LoginPage isClientMode onLogin={onLogin} />));
    await waitFor(() => expect(host.textContent).toContain(localHint.serverUrl));
    await act(async () => Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "auth.localDesktopLogin.fillButton")?.click());

    vi.stubGlobal("fetch", vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: "token-after-retry",
        user: { id: "user-local", username: "desktop" },
      }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await act(async () => host.querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      await waitFor(() => expect(onLogin).toHaveBeenCalledWith("token-after-retry", expect.objectContaining({ username: "desktop" })));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(host.textContent).not.toContain("auth.loginNoResponse");
    } finally {
      warnLog.mockRestore();
    }
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

  it("证书过期展示到期时间，重新检测不提交密码，并保留设备本地入口", async () => {
    const expiresAt = Date.UTC(2026, 5, 28, 23, 59, 59);
    vi.mocked(testServerConnection)
      .mockResolvedValueOnce({ ok: false, diagnostic: { kind: "certificateExpired", expiresAt } })
      .mockResolvedValueOnce({ ok: true });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const onLogin = vi.fn();
    const onContinueLocal = vi.fn();
    await act(async () => root?.render(<LoginPage isClientMode onLogin={onLogin} onContinueLocal={onContinueLocal} />));
    await waitFor(() => expect(host.textContent).toContain(localHint.serverUrl));
    await act(async () => Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "auth.localDesktopLogin.fillButton")?.click());
    await act(async () => host.querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await waitFor(() => {
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("auth.connectionIssues.certificateExpired");
      expect(host.textContent).toContain(new Date(expiresAt).toLocaleString());
    });
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "auth.recheckConnection")?.click());
    await waitFor(() => expect(host.querySelector('[role="alert"]')).toBeNull());
    expect(testServerConnection).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(onLogin).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')?.value).toBe(localHint.password);
    await act(async () => Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "auth.continueLocal")?.click());
    expect(onContinueLocal).toHaveBeenCalledTimes(1);
  });

  it("更换服务器后丢弃旧地址的迟到证书错误", async () => {
    let finishProbe!: (result: { ok: boolean; diagnostic: { kind: "certificateExpired" } }) => void;
    vi.mocked(testServerConnection).mockImplementationOnce(() => new Promise((resolve) => { finishProbe = resolve; }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<LoginPage isClientMode onLogin={vi.fn()} />));
    await waitFor(() => expect(host.textContent).toContain(localHint.serverUrl));
    await act(async () => Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "auth.localDesktopLogin.fillButton")?.click());
    await act(async () => Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === "auth.recheckConnection")?.click());
    const address = host.querySelector<HTMLInputElement>('input[aria-label="server.addressLabel"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(address, "new.example.com:443");
      address.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => finishProbe({ ok: false, diagnostic: { kind: "certificateExpired" } }));
    expect(address.value).toBe("new.example.com:443");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
