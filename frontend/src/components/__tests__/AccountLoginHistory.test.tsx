import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountLoginHistoryList } from "@/components/AccountLoginHistory";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("账号登录历史列表", () => {
  let root: Root | null = null;
  const remove = vi.fn(async () => ({ ok: true }));

  beforeEach(() => {
    localStorage.clear();
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
});
