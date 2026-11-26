import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

// Switching no longer probes /health first; compatible-path discovery is only
// used when /me returns a non-Nowen response and is stubbed per case here.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api")>(),
  discoverNowenApiPath: vi.fn(async () => null),
}));

import { discoverNowenApiPath } from "@/lib/api";
import { switchAccountLogin } from "@/lib/accountLoginSwitch";
import type { AccountLoginHistoryItem } from "@/lib/accountLoginHistory";
import { isMobileAccountLoginRequested, isMobileLocalMode, requestMobileAccountLogin } from "@/lib/mobileLocalMode";

const account: AccountLoginHistoryItem = {
  id: "history-1",
  serverUrl: "https://notes.example.com",
  userId: "user-1",
  username: "alice",
  displayName: "Alice",
  avatarUrl: "",
  lastUsedAt: 100,
  requiresReauth: false,
};

function installDesktopHistory(token = "target-token", remembered: any = null) {
  (window as any).nowenDesktop = {
    isDesktop: true,
    credentials: {
      load: vi.fn(async () => remembered),
    },
    accountHistory: {
      list: vi.fn(async () => [account]),
      save: vi.fn(async () => ({ ok: true, id: account.id })),
      loadToken: vi.fn(async () => ({ ok: true, token })),
      markRequiresReauth: vi.fn(async () => ({ ok: true })),
      remove: vi.fn(async () => ({ ok: true })),
    },
  };
}

describe("账号历史切换", () => {
  afterEach(() => { Reflect.deleteProperty(window, "Capacitor"); });
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("nowen-token", "current-token");
    localStorage.setItem("nowen-server-url", "https://current.example.com");
    installDesktopHistory();
    vi.restoreAllMocks();
  });

  it("验证成功后才替换当前服务器和令牌", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      id: "user-1", username: "alice", displayName: "Alice",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await switchAccountLogin(account);

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://notes.example.com/api/me",
      expect.objectContaining({ headers: { Authorization: "Bearer target-token" } }),
    );
    expect(result.status).toBe("switched");
    if (result.status === "switched") {
      expect(result.token).toBe("target-token");
      expect(result.user).toMatchObject({ id: "user-1", username: "alice" });
    }
    expect(localStorage.getItem("nowen-token")).toBe("target-token");
    expect(localStorage.getItem("nowen-server-url")).toBe("https://notes.example.com");
    expect(localStorage.getItem("nowen-account-history-current-id")).toBe(account.id);
  });

  it("目标服务器网络失败时保持当前会话不变", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await switchAccountLogin(account);

    expect(result.status).toBe("network_error");
    expect(localStorage.getItem("nowen-token")).toBe("current-token");
    expect(localStorage.getItem("nowen-server-url")).toBe("https://current.example.com");
  });

  it("安全存储临时读取失败时保持当前会话不变", async () => {
    (window as any).nowenDesktop.accountHistory.loadToken = vi.fn(async () => {
      throw new Error("IPC unavailable");
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await switchAccountLogin(account);

    expect(result.status).toBe("storage_error");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem("nowen-token")).toBe("current-token");
    expect(localStorage.getItem("nowen-server-url")).toBe("https://current.example.com");
  });

  it("令牌明确失效时保留账号并进入预填重登", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      code: "TOKEN_REVOKED",
      error: "登录已失效",
    }), { status: 401, headers: { "Content-Type": "application/json" } }));

    const result = await switchAccountLogin(account);

    expect(result.status).toBe("requires_reauth");
    expect(localStorage.getItem("nowen-token")).toBeNull();
    expect(localStorage.getItem("nowen-server-url")).toBe("https://notes.example.com");
    expect(sessionStorage.getItem("nowen-account-history-pending-reauth")).not.toContain("target-token");
    expect(localStorage.getItem("nowen-prefer-cloud")).toBe("1");
    expect((window as any).nowenDesktop.accountHistory.markRequiresReauth).toHaveBeenCalledWith(account.id);
  });

  it("Android 历史会话失效后进入登录页而不是本机空间", async () => {
    Object.assign(window, { Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      code: "TOKEN_REVOKED", error: "登录已失效",
    }), { status: 401 }));

    expect((await switchAccountLogin(account)).status).toBe("requires_reauth");
    expect(localStorage.getItem("nowen-token")).toBeNull();
    expect(isMobileLocalMode()).toBe(false);
    expect(localStorage.getItem("nowen-mobile-account-login-requested")).toBe("1");
  });

  it("Android 切换成功后清除主动登录标记并使用目标会话", async () => {
    Object.assign(window, { Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" } });
    requestMobileAccountLogin();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      id: account.userId, username: account.username,
    }), { status: 200 }));

    expect((await switchAccountLogin(account)).status).toBe("switched");
    expect(isMobileAccountLoginRequested()).toBe(false);
    expect(isMobileLocalMode()).toBe(false);
    expect(localStorage.getItem("nowen-token")).toBe("target-token");
  });

  it("令牌被撤销但保存了匹配密码时自动重新登录", async () => {
    installDesktopHistory("revoked-token", {
      serverUrl: account.serverUrl,
      username: account.username,
      password: "remembered-secret",
      hasPassword: true,
      autoLogin: false,
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: "SESSION_REVOKED",
        error: "该会话已被下线",
      }), { status: 401, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: "fresh-token",
        user: { id: "user-1", username: "alice", displayName: "Alice" },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await switchAccountLogin(account);

    expect(fetchSpy).toHaveBeenNthCalledWith(2,
      "https://notes.example.com/api/auth/login",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.status).toBe("switched");
    if (result.status === "switched") expect(result.token).toBe("fresh-token");
    expect(localStorage.getItem("nowen-token")).toBe("fresh-token");
  });

  it("用已保存密码重新登录时第一次没有响应，自动补发一次", async () => {
    installDesktopHistory("revoked-token", {
      serverUrl: account.serverUrl,
      username: account.username,
      password: "remembered-secret",
      hasPassword: true,
      autoLogin: false,
    });
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: "SESSION_REVOKED",
        error: "该会话已被下线",
      }), { status: 401, headers: { "Content-Type": "application/json" } }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: "fresh-token",
        user: { id: "user-1", username: "alice", displayName: "Alice" },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await switchAccountLogin(account);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy).toHaveBeenNthCalledWith(3,
      "https://notes.example.com/api/auth/login",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.status).toBe("switched");
    expect(localStorage.getItem("nowen-token")).toBe("fresh-token");
    warnLog.mockRestore();
  });

  it("已标记需重登的历史账号可直接使用匹配的已保存密码", async () => {
    installDesktopHistory("", {
      serverUrl: account.serverUrl,
      username: account.username,
      password: "remembered-secret",
      hasPassword: true,
      autoLogin: false,
    });
    (window as any).nowenDesktop.accountHistory.loadToken = vi.fn(async () => ({
      ok: false,
      error: "TOKEN_UNAVAILABLE",
    }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      token: "fresh-token",
      user: { id: "user-1", username: "alice", displayName: "Alice" },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await switchAccountLogin({ ...account, requiresReauth: true });

    expect(result.status).toBe("switched");
    expect(localStorage.getItem("nowen-token")).toBe("fresh-token");
  });
  it("不先探测 /health；/me 返回代理页面时在同一入口发现兼容路径后再校验", async () => {
    vi.mocked(discoverNowenApiPath).mockResolvedValueOnce({
      mode: "public-prefix",
      serverBaseUrl: "https://notes.example.com",
      apiBaseUrl: "https://notes.example.com/public/api",
      apiPath: "/public/api",
      websocketUrl: "wss://notes.example.com/public/ws",
      websocketPath: "/public/ws",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("<html>Lucky</html>", { status: 200, headers: { "Content-Type": "text/html" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "user-1", username: "alice" }), { status: 200 }));

    const result = await switchAccountLogin(account);

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "https://notes.example.com/api/me",
      "https://notes.example.com/public/api/me",
    ]);
    expect(discoverNowenApiPath).toHaveBeenCalledWith(account.serverUrl, "https://notes.example.com/api");
    expect(result.status).toBe("switched");
  });

  it("/me 返回代理页面且找不到 Nowen 路径时保持当前会话不变", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>gateway</html>", { status: 200 }));

    const result = await switchAccountLogin(account);

    expect(result.status).toBe("network_error");
    expect(localStorage.getItem("nowen-token")).toBe("current-token");
    expect(localStorage.getItem("nowen-server-url")).toBe("https://current.example.com");
  });

  it("DCC-006: 桌面端切换到远端账号时设置 prefer-cloud 防止重载被本机迁移覆盖，切回本机时清除该标记", async () => {
    const localAccount: AccountLoginHistoryItem = {
      id: "history-local",
      serverUrl: "http://127.0.0.1:57892",
      userId: "desktop-user",
      username: "desktop",
      displayName: "本机用户",
      avatarUrl: "",
      lastUsedAt: 200,
      requiresReauth: false,
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "user-1", username: "alice", displayName: "Alice",
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "desktop-user", username: "desktop", displayName: "本机用户",
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const remoteResult = await switchAccountLogin(account);
    expect(remoteResult.status).toBe("switched");
    expect(localStorage.getItem("nowen-prefer-cloud")).toBe("1");
    expect(localStorage.getItem("nowen-server-url")).toBe("https://notes.example.com");

    const localResult = await switchAccountLogin(localAccount);
    expect(localResult.status).toBe("switched");
    expect(localStorage.getItem("nowen-prefer-cloud")).toBeNull();
    expect(localStorage.getItem("nowen-server-url")).toBe("http://127.0.0.1:57892");
  });
});
