import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountLoginHistoryList } from "@/components/AccountLoginHistory";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/accountLoginSwitch", () => ({
  switchAccountLogin: vi.fn(),
}));

function changeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("账号历史服务器地址编辑", () => {
  let root: Root | null = null;
  let list: any;
  let save: any;
  let loadToken: any;
  let remove: any;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("nowen-token", "current-token");
    localStorage.setItem("nowen-server-url", "https://current.example.com");
    localStorage.setItem("nowen-account-history-current-id", "history-1");

    list = vi.fn(async () => [
      {
        id: "history-2",
        serverUrl: "http://192.168.10.44:7316",
        userId: "user-2",
        username: "admin",
        displayName: "管理员",
        avatarUrl: "",
        lastUsedAt: 200,
        requiresReauth: false,
      },
      {
        id: "history-1",
        serverUrl: "https://current.example.com",
        userId: "user-1",
        username: "alice",
        displayName: "Alice",
        avatarUrl: "",
        lastUsedAt: 100,
        requiresReauth: false,
      },
    ]);
    save = vi.fn(async () => ({ ok: true, id: "history-2-new" }));
    loadToken = vi.fn(async () => ({ ok: true, token: "saved-token", refreshToken: "saved-refresh" }));
    remove = vi.fn(async () => ({ ok: true }));

    (window as any).nowenDesktop = {
      isDesktop: true,
      accountHistory: {
        list,
        save,
        loadToken,
        markRequiresReauth: vi.fn(async () => ({ ok: true })),
        remove,
      },
    };
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    delete (window as any).nowenDesktop;
    vi.restoreAllMocks();
  });

  it("点击铅笔后测试新地址并迁移历史记录，不删除账号凭据", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ok", version: "1.5.0" }),
    } as Response);
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<AccountLoginHistoryList />);
      await flush();
    });

    const editButtons = host.querySelectorAll<HTMLButtonElement>('button[aria-label="auth.serverAddress"]');
    expect(editButtons).toHaveLength(2);
    await act(async () => {
      editButtons[0].click();
    });

    const input = document.querySelector<HTMLInputElement>("[data-account-server-input]");
    expect(input?.value).toBe("http://192.168.10.44:7316");
    await act(async () => {
      changeInput(input!, "192.168.10.50:7316");
    });

    await act(async () => {
      document.querySelector<HTMLButtonElement>("[data-account-server-save]")?.click();
      await flush();
      await flush();
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://192.168.10.50:7316/api/health",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
    expect(loadToken).toHaveBeenCalledWith("history-2");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: "http://192.168.10.50:7316",
      userId: "user-2",
      username: "admin",
      token: "saved-token",
      refreshToken: "saved-refresh",
      lastUsedAt: 200,
    }));
    expect(remove).toHaveBeenCalledWith("history-2");
    expect(document.querySelector("[data-account-server-input]")).toBeNull();
  });

  it("新地址健康检查失败时保留旧记录", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ status: "error" }),
    } as Response);
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<AccountLoginHistoryList />);
      await flush();
    });
    await act(async () => {
      host.querySelectorAll<HTMLButtonElement>('button[aria-label="auth.serverAddress"]')[0].click();
    });
    const input = document.querySelector<HTMLInputElement>("[data-account-server-input]");
    await act(async () => {
      changeInput(input!, "192.168.10.99:7316");
      document.querySelector<HTMLButtonElement>("[data-account-server-save]")?.click();
      await flush();
    });

    expect(save).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("auth.loginHistory.connectFailed");
  });
});
