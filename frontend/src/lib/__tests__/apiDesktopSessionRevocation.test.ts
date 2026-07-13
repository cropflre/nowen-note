import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";

describe("桌面端会话失效处理", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    delete (window as any).nowenDesktop;
  });

  it("收到 401 后先清除主进程本地认证缓存，避免刷新后重新注入失效 token", async () => {
    let finishClearLocalAuth!: () => void;
    const clearLocalAuth = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => {
      finishClearLocalAuth = () => resolve({ ok: true });
    }));
    (window as any).nowenDesktop = {
      isDesktop: true,
      clearLocalAuth,
    };
    localStorage.setItem("nowen-token", "expired-desktop-token");
    // jsdom 不实现真实页面导航；本用例只验证 reload 前的凭据清理时序。
    vi.spyOn(console, "error").mockImplementation(() => {});

    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "Token 无效或已过期", code: "TOKEN_INVALID" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    )));

    let requestSettled = false;
    const requestResult = api.getMe().then(
      (value) => ({ value, error: null }),
      (error: Error) => ({ value: null, error }),
    );
    void requestResult.then(() => { requestSettled = true; });

    await vi.waitFor(() => expect(clearLocalAuth).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(requestSettled).toBe(false);

    finishClearLocalAuth();
    const result = await requestResult;

    expect(result.error).toHaveProperty("message", "Token 无效或已过期");
    expect(localStorage.getItem("nowen-token")).toBeNull();
  });
});
