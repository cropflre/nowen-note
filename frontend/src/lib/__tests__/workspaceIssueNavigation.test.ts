import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ workspace: "team", set: vi.fn(), push: vi.fn() }));
vi.mock("../api", () => ({ getCurrentWorkspace: () => mocks.workspace, setCurrentWorkspace: mocks.set }));
vi.mock("../appPathNavigation", () => ({ pushAppPathState: mocks.push }));
import { openWorkspaceIssue, parseIssueAppPath } from "../workspaceIssueNavigation";

beforeEach(() => { vi.clearAllMocks(); });
it("解析议题列表与详情并拒绝额外路径", () => {
  expect(parseIssueAppPath("/issues")).toEqual({ matched: true, issueId: null });
  expect(parseIssueAppPath("/issues/issue-one")).toEqual({ matched: true, issueId: "issue-one" });
  expect(parseIssueAppPath("/issues/issue-one/unknown").matched).toBe(false);
  expect(parseIssueAppPath("/notes/issue-one").matched).toBe(false);
});
it("跨工作区通知先切换空间再导航", () => {
  const changed = vi.fn(); window.addEventListener("nowen:workspace-changed", changed);
  openWorkspaceIssue("issue-one", "other");
  expect(mocks.set).toHaveBeenCalledWith("other");
  expect(changed).toHaveBeenCalledOnce();
  expect(mocks.push).toHaveBeenCalledWith("/issues/issue-one");
  window.removeEventListener("nowen:workspace-changed", changed);
});
it("同工作区内打开列表不会重置工作区状态", () => {
  openWorkspaceIssue(null, "team");
  expect(mocks.set).not.toHaveBeenCalled();
  expect(mocks.push).toHaveBeenCalledWith("/issues");
});
