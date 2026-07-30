import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountLoginHistoryList } from "@/components/AccountLoginHistory";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const switchHarness = vi.hoisted(() => ({ switchAccountLogin: vi.fn() }));

vi.mock("@/lib/accountLoginSwitch", () => ({
  switchAccountLogin: switchHarness.switchAccountLogin,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("账号登录历史列表", () => {
  let root: Root | null = null;
  const remove = vi.fn(async () => ({ ok: true }));

  beforeEach(() => {
    localStorage.clear();
    switchHarness.switchAccountLogin.mockReset();
    (window as any).nowenDesktop = {
      isDesktop: true,
      accountHistory: {
        list: vi.fn(async () => [
          {
            id: "history-2",
            serverUrl: "https://other.example.com",
            userId: "user-2",
            username: "bob",
            displayName: "Bob",
            avatarUrl: "",
            lastUsedAt: 200,
            requiresReauth: true,
          },
          {
            id: "history-1",
            serverUrl: "https://notes.example.com",
            userId: "user-1",
            username: "alice",
            displayName: "Alice",
            avatarUrl: "",
            lastUsedAt: 100,
            requiresReauth: false,
          },
        ]),
        save: vi.fn(async () => ({ ok: true })),
        loadToken: vi.fn(async () => ({ ok: false, error: "TOKEN_UNAVAILABLE" })),
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

  it("展示不同服务器上的全部账号及重登状态", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<AccountLoginHistoryList title="最近登录" />);
      await Promise.resolve();
    });

    expect(host.textContent).toContain("最近登录");
    expect(host.textContent).toContain("Bob");
    expect(host.textContent).toContain("other.example.com");
    expect(host.textContent).toContain("Alice");
    expect(host.textContent).toContain("notes.example.com");
    expect(host.textContent).toContain("auth.loginHistory.reauth");
  });

  it("可单独删除一条历史记录", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<AccountLoginHistoryList />);
      await Promise.resolve();
    });

    const buttons = host.querySelectorAll<HTMLButtonElement>('button[aria-label="auth.loginHistory.remove"]');
    await act(async () => {
      buttons[0].click();
      await Promise.resolve();
    });

    expect(remove).toHaveBeenCalledWith("history-2");
  });

  it("登录页点击最近账号后直接建立登录态，不触发整页刷新", async () => {
    const switchedUser = {
      id: "user-2",
      username: "bob",
      email: null,
      avatarUrl: null,
      displayName: "Bob",
      createdAt: "2026-07-28T00:00:00.000Z",
    };
    switchHarness.switchAccountLogin.mockResolvedValue({
      status: "switched",
      token: "target-token",
      user: switchedUser,
    });
    const onSwitched = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<AccountLoginHistoryList onSwitched={onSwitched} />);
      await Promise.resolve();
    });
    const accountButton = host.querySelector<HTMLButtonElement>("[data-account-login-history] div button");
    await act(async () => {
      accountButton?.click();
      await Promise.resolve();
    });

    expect(onSwitched).toHaveBeenCalledWith("target-token", switchedUser);
  });

  it("历史会话失效时在登录页原地预填重登，不触发整页刷新", async () => {
    switchHarness.switchAccountLogin.mockResolvedValue({
      status: "requires_reauth",
      message: "该会话已被下线",
    });
    const onRequiresReauth = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<AccountLoginHistoryList onRequiresReauth={onRequiresReauth} />);
      await Promise.resolve();
    });
    const accountButton = host.querySelector<HTMLButtonElement>("[data-account-login-history] div button");
    await act(async () => {
      accountButton?.click();
      await Promise.resolve();
    });

    expect(onRequiresReauth).toHaveBeenCalledWith(
      expect.objectContaining({ id: "history-2", username: "bob" }),
      "该会话已被下线",
    );
  });

  it("登录页默认只展示最近两个账号，可展开查看其余账号", async () => {
    (window as any).nowenDesktop.accountHistory.list = vi.fn(async () => [
      {
        id: "history-4",
        serverUrl: "https://four.example.com",
        userId: "user-4",
        username: "dora",
        displayName: "Dora",
        avatarUrl: "",
        lastUsedAt: 400,
        requiresReauth: false,
      },
      {
        id: "history-3",
        serverUrl: "https://three.example.com",
        userId: "user-3",
        username: "charlie",
        displayName: "Charlie",
        avatarUrl: "",
        lastUsedAt: 300,
        requiresReauth: false,
      },
      {
        id: "history-2",
        serverUrl: "https://other.example.com",
        userId: "user-2",
        username: "bob",
        displayName: "Bob",
        avatarUrl: "",
        lastUsedAt: 200,
        requiresReauth: false,
      },
      {
        id: "history-1",
        serverUrl: "https://notes.example.com",
        userId: "user-1",
        username: "alice",
        displayName: "Alice",
        avatarUrl: "",
        lastUsedAt: 100,
        requiresReauth: false,
      },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root?.render(<AccountLoginHistoryList title="最近登录" />);
      await Promise.resolve();
    });

    expect(host.textContent).toContain("Dora");
    expect(host.textContent).toContain("Charlie");
    expect(host.textContent).not.toContain("Bob");
    const toggle = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("auth.loginHistory.showAll"),
    );
    await act(async () => {
      (toggle as HTMLButtonElement)?.click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain("Bob");
    expect(host.textContent).toContain("Alice");
  });
});
