import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceIssueDetail } from "@/types/workspaceIssues";

const mocks = vi.hoisted(() => ({
  workspace: "team", local: false, open: vi.fn(), actions: { setActiveNote: vi.fn(), setViewMode: vi.fn(), setMobileView: vi.fn() },
  list: vi.fn(), get: vi.fn(), activity: vi.fn(), create: vi.fn(), update: vi.fn(), comment: vi.fn(), editComment: vi.fn(), deleteComment: vi.fn(), getNotes: vi.fn(), getNote: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  getCurrentWorkspace: () => mocks.workspace, setCurrentWorkspace: (id: string) => { mocks.workspace = id; },
  api: { issues: { list: mocks.list, get: mocks.get, activity: mocks.activity, create: mocks.create, update: mocks.update, comment: mocks.comment, editComment: mocks.editComment, deleteComment: mocks.deleteComment }, getNotes: mocks.getNotes, getNote: mocks.getNote },
}));
vi.mock("@/lib/workspaceIssueNavigation", () => ({ openWorkspaceIssue: mocks.open, NOTIFICATIONS_CHANGED_EVENT: "nowen:notifications-changed" }));
vi.mock("@/store/AppContext", () => ({ useAppActions: () => mocks.actions }));
vi.mock("@/lib/mobileLocalMode", () => ({ isMobileLocalMode: () => mocks.local }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import WorkspaceIssues from "../WorkspaceIssues";

const issue: WorkspaceIssueDetail = {
  id: "issue-one", workspaceId: "team", number: 1, title: "讨论手机布局", content: "**正文**", status: "open", createdBy: "editor", closedBy: null, closedAt: null,
  relatedNoteId: null, relatedNote: null, authorName: "成员", commentCount: 0, createdAt: "2026-09-29T01:00:00Z", updatedAt: "2026-09-29T01:00:00Z", canEdit: true, canComment: true, canChangeStatus: true,
};

describe("工作区议题界面", () => {
  let root: Root;
  let host: HTMLDivElement;
  async function render(id: string | null = null) { await act(async () => { root.render(<WorkspaceIssues key={id ?? "list"} issueId={id} />); }); }
  function button(text: string) { return [...host.querySelectorAll("button")].find((item) => item.textContent === text)!; }
  async function click(text: string) { await act(async () => button(text).click()); }
  async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
    await act(async () => {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspace = "team";
    mocks.local = false;
    mocks.list.mockResolvedValue({ items: [issue], total: 1, canCreate: true, role: "editor" });
    mocks.get.mockResolvedValue(issue);
    mocks.activity.mockResolvedValue({ items: [], total: 0 });
    mocks.getNotes.mockResolvedValue([{ id: "note-one", title: "说明笔记" }]);
    mocks.create.mockResolvedValue({ ...issue, id: "new-issue" });
    mocks.update.mockResolvedValue(issue);
    mocks.comment.mockResolvedValue({ id: "new-comment" });
    mocks.editComment.mockResolvedValue({ success: true });
    mocks.deleteComment.mockResolvedValue({ success: true });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-keyboard"); document.documentElement.style.removeProperty("--keyboard-height");
  });

  it("按当前工作区加载并切换全部、进行中、关闭过滤", async () => {
    await render();
    expect(mocks.list).toHaveBeenCalledWith("team", "open");
    expect(host.textContent).toContain("讨论手机布局");
    await click("issues.closed");
    expect(mocks.list).toHaveBeenLastCalledWith("team", "closed");
    await click("issues.all");
    expect(mocks.list).toHaveBeenLastCalledWith("team", "all");
    await act(async () => host.querySelector<HTMLButtonElement>("button h2")!.parentElement!.parentElement!.click());
    expect(mocks.open).toHaveBeenCalledWith("issue-one");
  });

  it("加载更多保留前一页，避免刷新回第一页", async () => {
    mocks.list.mockImplementation((_workspace: string, _status: string, offset = 0) => Promise.resolve({ items: [{ ...issue, id: offset ? "issue-two" : "issue-one", title: offset ? "第二页议题" : "第一页议题" }], total: 2, canCreate: true, role: "editor" }));
    await render(); await click("issues.more");
    expect(mocks.list).toHaveBeenLastCalledWith("team", "open", 1);
    expect(host.textContent).toContain("第一页议题");
    expect(host.textContent).toContain("第二页议题");
    expect(button("issues.more")).toBeUndefined();
  });

  it("创建时发送关联笔记，服务器成功后才进入详情", async () => {
    await render(); await click("issues.create");
    await input(host.querySelector("input")!, "新议题");
    await input(host.querySelector("textarea")!, "讨论内容");
    await act(async () => { const select = host.querySelector("select")!; select.value = "note-one"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.create).toHaveBeenCalledWith({ workspaceId: "team", title: "新议题", content: "讨论内容", relatedNoteId: "note-one" });
    expect(mocks.open).toHaveBeenCalledWith("new-issue");
  });

  it("创建失败保留草稿并显示错误", async () => {
    mocks.create.mockRejectedValue(new Error("网络不可达"));
    await render(); await click("issues.create"); await input(host.querySelector("input")!, "保留草稿");
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("网络不可达");
    expect(host.querySelector("input")!.value).toBe("保留草稿");
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("切换工作区后旧创建响应不能抢回导航", async () => {
    let resolve!: (value: unknown) => void;
    mocks.create.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await render(); await click("issues.create"); await input(host.querySelector("input")!, "旧工作区草稿");
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => { mocks.workspace = "other"; window.dispatchEvent(new Event("nowen:workspace-changed")); });
    await act(async () => resolve({ ...issue, id: "old-response" }));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenLastCalledWith("other", "open");
  });

  it("查看者不显示创建、回复和状态修改入口", async () => {
    mocks.get.mockResolvedValue({ ...issue, canEdit: false, canComment: false, canChangeStatus: false });
    await render(issue.id);
    expect(host.querySelector("textarea")).toBeNull();
    expect(button("issues.close")).toBeUndefined();
    expect(button("issues.edit")).toBeUndefined();
    expect(host.textContent).toContain("issues.readOnly");
  });

  it("关联笔记请求返回前切换工作区，不能打开旧空间的笔记", async () => {
    mocks.get.mockResolvedValue({ ...issue, relatedNoteId: "linked-note", relatedNote: { id: "linked-note", title: "关联文档" } });
    let resolve!: (value: unknown) => void;
    mocks.getNote.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await render(issue.id);
    await click("issues.relatedNote: 关联文档");
    await act(async () => { mocks.workspace = "other"; window.dispatchEvent(new Event("nowen:workspace-changed")); });
    await act(async () => resolve({ id: "linked-note", workspaceId: "team" }));
    expect(mocks.actions.setActiveNote).not.toHaveBeenCalled();
  });

  it("发送回复后清空输入，关闭和重新打开沿用当前议题", async () => {
    await render(issue.id); await input(host.querySelector("textarea")!, "我的回复");
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.comment).toHaveBeenCalledWith(issue.id, "我的回复");
    expect(host.querySelector("textarea")!.value).toBe("");
    await click("issues.close");
    expect(mocks.update).toHaveBeenLastCalledWith(issue.id, { status: "closed" });
    mocks.get.mockResolvedValue({ ...issue, status: "closed" });
    await click("issues.refresh"); await click("issues.reopen");
    expect(mocks.update).toHaveBeenLastCalledWith(issue.id, { status: "open" });
  });

  it("按服务端权限编辑和删除自己的评论，并安全显示 Markdown", async () => {
    mocks.activity.mockResolvedValue({ items: [{ id: "mine", type: "comment", authorName: "我", content: "<img src=x onerror=alert(1)>\n\n**回复**", canEdit: true, createdAt: issue.createdAt, updatedAt: issue.createdAt }], total: 1 });
    await render(issue.id);
    expect(host.querySelector("img")).toBeNull();
    const comment = host.querySelectorAll("article")[1];
    await act(async () => [...comment.querySelectorAll("button")].find((item) => item.textContent === "issues.edit")!.click());
    await input(comment.querySelector("textarea")!, "修改回复");
    await act(async () => comment.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.editComment).toHaveBeenCalledWith(issue.id, "mine", "修改回复");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => [...comment.querySelectorAll("button")].find((item) => item.textContent === "issues.delete")!.click());
    expect(mocks.deleteComment).toHaveBeenCalledWith(issue.id, "mine");
    vi.restoreAllMocks();
  });

  it("个人空间和原生本地模式不请求工作区 API", async () => {
    mocks.workspace = "personal"; await render();
    expect(mocks.list).not.toHaveBeenCalled(); expect(host.textContent).toContain("issues.personal");
    mocks.local = true; await render(issue.id);
    expect(mocks.get).not.toHaveBeenCalled(); expect(host.textContent).toContain("issues.local");
  });

  it("Android 覆盖键盘时议题滚动区域使用可见高度", async () => {
    vi.stubGlobal("innerHeight", 800); await render(issue.id);
    await act(async () => { document.documentElement.dataset.keyboard = "open"; document.documentElement.style.setProperty("--keyboard-height", "300px"); await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(host.querySelector<HTMLElement>('[data-testid="workspace-issues"]')!.style.maxHeight).toBe("500px");
    expect(host.querySelector("textarea")).not.toBeNull();
  });
});
