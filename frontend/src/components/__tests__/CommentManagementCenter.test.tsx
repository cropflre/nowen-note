import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn(), resolve: vi.fn(), confirm: vi.fn(), local: false }));
vi.mock("@/lib/api", () => ({ api: { getManagedNoteComments: mocks.list, deleteNoteComment: mocks.remove, toggleCommentResolved: mocks.resolve }, SERVER_URL_CHANGED_EVENT: "nowen:server-url-changed" }));
vi.mock("@/lib/mobileLocalMode", () => ({ isMobileLocalMode: () => mocks.local }));
vi.mock("@/lib/noteCommentNavigation", () => ({ OPEN_COMMENT_CENTER_EVENT: "nowen:open-comment-center", COMMENTS_CHANGED_EVENT: "nowen:comments-changed" }));
vi.mock("@/lib/workspaceIssueNavigation", () => ({ NOTIFICATIONS_CHANGED_EVENT: "nowen:notifications-changed" }));
vi.mock("@/components/ui/confirm", () => ({ confirm: mocks.confirm }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import CommentManagementCenter from "../CommentManagementCenter";

const item = { id: "comment", noteId: "note", noteTitle: "待处理文档", displayName: "访客甲", isGuest: 1, parentId: null, content: "需要处理的留言", isResolved: 0, createdAt: "2026-09-30T01:00:00Z" };
describe("跨笔记评论管理中心", () => {
  let root: Root; let host: HTMLDivElement;
  const navigate = vi.fn();
  const button = (text: string) => [...document.querySelectorAll("button")].find((element) => element.textContent === text)!;
  async function open() { await act(async () => window.dispatchEvent(new Event("nowen:open-comment-center"))); }
  beforeEach(async () => {
    vi.clearAllMocks(); vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); mocks.local = false;
    mocks.list.mockResolvedValue({ items: [item], total: 1 }); mocks.remove.mockResolvedValue({ success: true }); mocks.resolve.mockResolvedValue({ ...item, isResolved: 1 }); mocks.confirm.mockResolvedValue(true); navigate.mockResolvedValue(undefined);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(<CommentManagementCenter onOpenComment={navigate} />));
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("仅打开时请求，显示所属笔记、访客和评论内容", async () => {
    expect(mocks.list).not.toHaveBeenCalled(); await open();
    expect(mocks.list).toHaveBeenCalledWith("unresolved", "", 0, 30);
    expect(document.body.textContent).toContain(item.noteTitle); expect(document.body.textContent).toContain(item.content); expect(document.body.textContent).toContain("访客甲");
  });
  it("状态筛选和搜索重置分页，分页加载下一批评论", async () => {
    mocks.list.mockResolvedValue({ items: [item], total: 31 }); await open();
    await act(async () => button("commentCenter.next").click());
    expect(mocks.list).toHaveBeenLastCalledWith("unresolved", "", 30, 30);
    const select = document.querySelector("select")!;
    await act(async () => { select.value = "resolved"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(mocks.list).toHaveBeenLastCalledWith("resolved", "", 0, 30);
    const input = document.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  关键词  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("commentCenter.searchButton").click());
    expect(mocks.list).toHaveBeenLastCalledWith("resolved", "关键词", 0, 30);
  });
  it("解决与删除复用原接口并刷新，删除前确认", async () => {
    await open();
    await act(async () => button("commentCenter.resolve").click());
    expect(mocks.resolve).toHaveBeenCalledWith(item.noteId, item.id);
    await act(async () => button("issues.delete").click());
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    expect(mocks.remove).toHaveBeenCalledWith(item.noteId, item.id);
  });
  it("跳转成功关闭面板，权限错误保留面板供重试", async () => {
    await open(); navigate.mockRejectedValueOnce(new Error("无权读取评论"));
    await act(async () => button("commentCenter.open").click());
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("无权读取评论");
    await act(async () => button("commentCenter.open").click());
    expect(navigate).toHaveBeenCalledWith(item.noteId, item.id); expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it.each(["nowen:token-changed", "nowen:server-url-changed"])("%s 使旧请求失效并清空旧评论", async (event) => {
    let resolve!: (value: unknown) => void;
    mocks.list.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await open(); await act(async () => window.dispatchEvent(new Event(event)));
    await act(async () => resolve({ items: [item], total: 1 }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    mocks.list.mockResolvedValue({ items: [], total: 0 }); await open();
    expect(document.body.textContent).not.toContain(item.content);
  });
  it("确认期间账号切换不能删除旧账号评论", async () => {
    let resolve!: (value: boolean) => void;
    mocks.confirm.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await open(); await act(async () => button("issues.delete").click());
    await act(async () => window.dispatchEvent(new Event("nowen:token-changed")));
    await act(async () => resolve(true)); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("纯设备模式不访问远端，Escape 关闭并停止轮询", async () => {
    mocks.local = true; await open(); expect(mocks.list).not.toHaveBeenCalled();
    mocks.local = false; await open(); const count = mocks.list.mock.calls.length;
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(90000)); expect(mocks.list).toHaveBeenCalledTimes(count);
  });
});
