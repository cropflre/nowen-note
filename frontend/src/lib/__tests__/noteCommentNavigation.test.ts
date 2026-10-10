import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getNote: vi.fn(), workspace: "team", token: "account-a", server: "server-a", setWorkspace: vi.fn(), path: vi.fn(), panel: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { getNote: mocks.getNote }, getCurrentWorkspace: () => mocks.workspace, setCurrentWorkspace: mocks.setWorkspace, getServerUrl: () => mocks.server }));
vi.mock("@/lib/authSession", () => ({ getAccessToken: () => mocks.token }));
vi.mock("@/lib/noteDeepLink", () => ({ pushNoteAppPath: mocks.path }));
vi.mock("@/lib/inlineCommentEvents", () => ({ openInlineCommentPanel: mocks.panel }));
import { openNoteComment } from "../noteCommentNavigation";
const note = { id: "note", title: "原件", workspaceId: null, isTrashed: 0 };
describe("评论导航复用笔记原件路由", () => {
  const activate = vi.fn();
  beforeEach(() => { vi.clearAllMocks(); mocks.workspace = "team"; mocks.token = "account-a"; mocks.server = "server-a"; mocks.getNote.mockResolvedValue(note); });
  afterEach(() => { vi.restoreAllMocks(); });
  it("重新读取笔记并切回个人空间，再打开指定评论", async () => {
    const changed = vi.fn(); window.addEventListener("nowen:workspace-changed", changed);
    try {
      await openNoteComment("note", "reply", activate);
      expect(mocks.getNote).toHaveBeenCalledWith("note"); expect(mocks.setWorkspace).toHaveBeenCalledWith("");
      expect(changed).toHaveBeenCalledTimes(1); expect(activate).toHaveBeenCalledWith(note);
      expect(mocks.path).toHaveBeenCalledWith("note"); expect(mocks.panel).toHaveBeenCalledWith({ noteId: "note", noteTitle: "原件", commentId: "reply" });
      expect(activate.mock.invocationCallOrder[0]).toBeLessThan(mocks.path.mock.invocationCallOrder[0]);
    } finally { window.removeEventListener("nowen:workspace-changed", changed); }
  });
  it("同一工作区不重置会话，受限笔记和回收站原件不能跳转", async () => {
    mocks.getNote.mockResolvedValue({ ...note, workspaceId: "team" }); await openNoteComment("note", "comment", activate);
    expect(mocks.setWorkspace).not.toHaveBeenCalled();
    mocks.path.mockClear(); mocks.getNote.mockRejectedValueOnce(new Error("权限不足"));
    await expect(openNoteComment("note", "comment", activate)).rejects.toThrow("权限不足");
    mocks.getNote.mockResolvedValue({ ...note, isTrashed: 1 });
    await expect(openNoteComment("note", "comment", activate)).rejects.toThrow("回收站");
    expect(mocks.path).not.toHaveBeenCalled();
  });
  it.each(["token", "server"] as const)("读取过程中 %s 改变，旧结果不能激活笔记", async (field) => {
    mocks.getNote.mockImplementationOnce(async () => { mocks[field] = "changed"; return note; });
    await expect(openNoteComment("note", "comment", activate)).rejects.toThrow("切换");
    expect(activate).not.toHaveBeenCalled(); expect(mocks.panel).not.toHaveBeenCalled();
  });
});
