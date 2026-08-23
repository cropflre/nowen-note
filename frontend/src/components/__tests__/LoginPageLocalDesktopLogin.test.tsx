import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "../LoginPage";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/useSiteSettings", () => ({
  useSiteSettings: () => ({
    siteConfig: { title: "nowen-note", favicon: "", icpBeian: "", editorFontFamily: "" },
  }),
}));

vi.mock("@/hooks/useCapacitor", () => ({ useKeyboardLayout: () => {} }));
vi.mock("@/hooks/useKeyboardVisible", () => ({ useKeyboardVisible: () => ({ height: 0 }) }));
vi.mock("@/components/LanDiscoveryPanel", () => ({
  default: () => <div data-lan-discovery />,
}));
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
    (window as any).nowenDesktop = { isDesktop: true };
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
    delete (window as any).nowenDesktop;
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
    expect(host.querySelector("[data-lan-discovery]")).not.toBeNull();

    await act(async () => {
      host.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    await waitFor(() => {
      expect(completeLocalLoginHint).toHaveBeenCalledWith(localHint.serverUrl, localHint.username);
      expect(onLogin).toHaveBeenCalledWith("token-local", expect.objectContaining({ username: "desktop" }));
      expect(host.querySelector("[data-desktop-local-login-hint]")).toBeNull();
    });
  });

  it("远程服务器地址下隐藏局域网发现", async () => {
    localStorage.setItem("nowen-server-url-last", "https://note.nowen.cn");
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<LoginPage isClientMode onLogin={vi.fn()} />);
    });

    await waitFor(() => {
      const inputs = Array.from(host.querySelectorAll<HTMLInputElement>("input"));
      expect(inputs.some((input) => input.value.includes("note.nowen.cn"))).toBe(true);
      expect(host.querySelector("[data-lan-discovery]")).toBeNull();
    });
  });
});
