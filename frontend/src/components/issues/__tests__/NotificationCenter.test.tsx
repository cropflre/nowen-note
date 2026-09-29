import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), readAll: vi.fn(), local: false }));
vi.mock("@/lib/api", () => ({ api: { notifications: { list: mocks.list, read: mocks.read, readAll: mocks.readAll } }, SERVER_URL_CHANGED_EVENT: "nowen:server-url-changed" }));
vi.mock("@/lib/mobileLocalMode", () => ({ isMobileLocalMode: () => mocks.local }));
vi.mock("@/lib/workspaceIssueNavigation", () => ({ OPEN_NOTIFICATIONS_EVENT: "nowen:open-notifications", NOTIFICATIONS_CHANGED_EVENT: "nowen:notifications-changed" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import NotificationCenter from "../NotificationCenter";

const item = { id: "notice-one", workspaceId: "team", workspaceName: "团队", type: "issue_commented", actorName: "成员", resourceId: "issue-one", title: "讨论手机布局", body: "新的回复", readAt: null, createdAt: "2026-09-29T01:00:00Z" };
describe("站内通知中心", () => {
  let root: Root;
  let host: HTMLDivElement;
  const count = vi.fn();
  const openIssue = vi.fn();
  async function mount() { await act(async () => root.render(<NotificationCenter onUnreadChange={count} onOpenIssue={openIssue} />)); }
  async function open() { await act(async () => window.dispatchEvent(new Event("nowen:open-notifications"))); }
  function button(text: string) { return [...document.querySelectorAll("button")].find((element) => element.textContent === text)!; }
  beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers(); mocks.local = false;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.list.mockResolvedValue({ items: [item], total: 1, unreadCount: 1 });
    mocks.read.mockResolvedValue({ success: true }); mocks.readAll.mockResolvedValue({ success: true });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

  it("全局只轮询一次并更新未读数，卸载后停止轮询", async () => {
    await mount(); expect(count).toHaveBeenCalledWith(1);
    expect(mocks.list).toHaveBeenCalledWith(false, 0, 1);
    await act(async () => vi.advanceTimersByTimeAsync(45000));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
    await act(async () => vi.advanceTimersByTimeAsync(90000));
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("打开通知、筛选未读并标记全部已读", async () => {
    await mount(); await open(); expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => button("notificationCenter.unread").click());
    expect(mocks.list).toHaveBeenLastCalledWith(true, 0, 30);
    mocks.list.mockResolvedValue({ items: [], total: 0, unreadCount: 0 });
    await act(async () => button("notificationCenter.readAll").click());
    expect(mocks.readAll).toHaveBeenCalledTimes(1); expect(count).toHaveBeenLastCalledWith(0);
  });

  it("点击通知先标记本人通知已读，再打开对应工作区议题", async () => {
    await mount(); await open();
    await act(async () => document.querySelector<HTMLButtonElement>("button p.font-medium")!.parentElement!.click());
    expect(mocks.read).toHaveBeenCalledWith(item.id);
    expect(openIssue).toHaveBeenCalledWith(item.resourceId, item.workspaceId);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("通知权限过期显示错误且不跳转", async () => {
    mocks.read.mockRejectedValue(new Error("通知不存在"));
    await mount(); await open();
    await act(async () => document.querySelector<HTMLButtonElement>("button p.font-medium")!.parentElement!.click());
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("通知不存在");
    expect(openIssue).not.toHaveBeenCalled();
  });

  it("分页后定期刷新未读数保留已经加载的通知", async () => {
    const firstPage = Array.from({ length: 30 }, (_, index) => ({ ...item, id: `notice-${index}`, title: `通知 ${index}` }));
    mocks.list.mockImplementation((_unread: boolean, offset = 0, limit = 30) => Promise.resolve({ items: offset ? [{ ...item, id: "last-notice", title: "最后一条通知" }] : firstPage.slice(0, limit), total: 31, unreadCount: 31 }));
    await mount(); await open();
    await act(async () => button("issues.more").click());
    expect(document.body.textContent).toContain("最后一条通知");
    await act(async () => vi.advanceTimersByTimeAsync(45000));
    expect(document.body.textContent).toContain("最后一条通知");
    expect(mocks.list).toHaveBeenLastCalledWith(false, 0, 1);
  });

  it("服务器切换使旧请求失效，不能显示旧服务器通知", async () => {
    let resolve!: (value: unknown) => void;
    mocks.list.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await mount();
    mocks.list.mockResolvedValue({ items: [], total: 0, unreadCount: 0 });
    await act(async () => window.dispatchEvent(new Event("nowen:server-url-changed")));
    await act(async () => resolve({ items: [item], total: 1, unreadCount: 9 }));
    expect(count).not.toHaveBeenCalledWith(9);
    await open(); expect(document.body.textContent).not.toContain(item.title);
  });

  it("Escape 关闭弹层，本地离线模式不访问远端", async () => {
    await mount(); await open();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    mocks.local = true; mocks.list.mockClear(); await act(async () => window.dispatchEvent(new Event("nowen:server-url-changed")));
    await act(async () => vi.advanceTimersByTimeAsync(45000)); expect(mocks.list).not.toHaveBeenCalled();
  });
});
