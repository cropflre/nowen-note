import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NotificationCenter from "@/components/issues/NotificationCenter";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload?: unknown) => void>>();
  return {
    list: vi.fn(),
    listeners,
    on: (type: string, handler: (payload?: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
      return () => {
        listeners.get(type)?.delete(handler);
      };
    },
    emit: (type: string, payload?: unknown) => {
      listeners.get(type)?.forEach((fn) => fn(payload));
    },
  };
});

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@/lib/api", () => ({
  SERVER_URL_CHANGED_EVENT: "nowen:server-url-changed",
  api: {
    notifications: {
      list: mocks.list,
      read: vi.fn(),
      readAll: vi.fn(),
    },
  },
}));
vi.mock("@/lib/realtime", () => ({
  realtime: {
    on: mocks.on,
  },
}));
vi.mock("@/lib/mobileLocalMode", () => ({ isMobileLocalMode: () => false }));
vi.mock("@/hooks/useVisibleViewport", () => ({ useVisibleViewport: () => ({ top: 0, height: 600 }) }));

describe("NotificationCenter 实时 WebSocket 刷新", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("收到 notification:created 实时事件后立即刷新未读数，不依赖 45 秒轮询", async () => {
    const onUnreadChange = vi.fn();
    mocks.list
      .mockResolvedValueOnce({ items: [], total: 0, unreadCount: 0 })
      .mockResolvedValueOnce({ items: [], total: 1, unreadCount: 2 });

    await act(async () => {
      root.render(
        <NotificationCenter
          onUnreadChange={onUnreadChange}
          onOpenIssue={vi.fn()}
        />,
      );
    });

    expect(onUnreadChange).toHaveBeenLastCalledWith(0);

    await act(async () => {
      mocks.emit("notification:created", { resourceType: "workspace_issue", resourceId: "issue-1" });
    });

    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(onUnreadChange).toHaveBeenLastCalledWith(2);
  });
});
