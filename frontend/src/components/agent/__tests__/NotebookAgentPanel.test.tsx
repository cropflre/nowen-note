import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { AgentWorkflow } from "@/lib/agentWorkflow";
const mocks = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), create: vi.fn(), action: vi.fn(), reviseTasks: vi.fn(), capabilities: vi.fn(), books: vi.fn(),
  current: vi.fn(), refresh: vi.fn(), navigateTask: vi.fn(), refreshNotes: vi.fn(), refreshNotebooks: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
vi.mock("@/lib/api", () => ({ api: { agentWorkflows: mocks, agent: { capabilities: mocks.capabilities }, getNotebooks: mocks.books } }));
vi.mock("@/lib/taskComposerApi", () => ({ getTaskComposerContext: () => ({ workspaceId: "personal", scopeKey: "scope", baseUrl: "/api" }), isTaskComposerContextCurrent: mocks.current, refreshAgentTaskResults: mocks.refresh }));
vi.mock("@/lib/taskNotifications", () => ({ queueTaskNavigation: mocks.navigateTask }));
vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: { activeNote: null, selectedNotebookId: "book" } }), useAppActions: () => ({ refreshNotes: mocks.refreshNotes, refreshNotebooks: mocks.refreshNotebooks, setViewMode: vi.fn() }) }));
import NotebookAgentPanel from "../NotebookAgentPanel";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const run: AgentWorkflow = { id: "run", notebookId: "book", workspaceId: null, createdAt: "2026-10-23T00:00:00Z", updatedAt: "2026-10-23T00:00:00Z", status: "waiting_approval", errorCode: null, steps: [], actions: [{ kind: "note", status: "pending", resourceIds: [], errorCode: null }, { kind: "tasks", status: "pending", resourceIds: [], errorCode: null }], preview: { summary: '<img src=x onerror="alert(1)">', note: { title: "New note", content: '<script>alert(1)</script>' }, sources: [], contextTruncated: false, linkNoteId: null, token: "a".repeat(64) } };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks(); mocks.current.mockReturnValue(true); mocks.books.mockResolvedValue([{ id: "book", name: "Book" }]);
  mocks.capabilities.mockResolvedValue({ enabled: true }); mocks.list.mockResolvedValue([run]); mocks.get.mockResolvedValue(run);
  mocks.action.mockResolvedValue({ ...run, status: "completed", preview: undefined });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function render() { await act(async () => root.render(<NotebookAgentPanel workspaceId="personal" />)); }
const button = (key: string) => [...host.querySelectorAll("button")].find(element => element.textContent === key)!;
it("renders untrusted summaries and note drafts as text; never writes before approval", async () => {
  await render(); expect(host.querySelector("img,script")).toBeNull(); expect(host.textContent).toContain('<script>alert(1)</script>');
  expect(mocks.action).not.toHaveBeenCalled();
  await act(async () => button("agent.reject").click());
  expect(mocks.action).toHaveBeenCalledWith("personal", "run", "reject", undefined);
  expect(mocks.refresh).not.toHaveBeenCalled();
});
it("double approval sends the server-bound token only once", async () => {
  await render(); let finish!: (value: unknown) => void;
  mocks.action.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => { button("agent.workflow.approve").click(); button("agent.workflow.approve").click(); });
  expect(mocks.action).toHaveBeenCalledTimes(1); expect(mocks.action).toHaveBeenCalledWith("personal", "run", "approve", run.preview!.token);
  await act(async () => finish({ ...run, status: "completed", preview: undefined }));
});
it("partial execution shows real results and requires a new preview before retry approval", async () => {
  mocks.get.mockResolvedValue({ ...run, status: "partial", actions: [{ kind: "note", status: "completed", resourceIds: ["saved-note"], errorCode: null }, { kind: "tasks", status: "failed", resourceIds: [], errorCode: "WRITE_FAILED" }] });
  await render(); expect(button("agent.workflow.openNote")).toBeTruthy(); expect(button("agent.workflow.approve")).toBeUndefined();
  mocks.action.mockResolvedValue({ ...run, preview: { ...run.preview, token: "b".repeat(64) } });
  await act(async () => button("agent.workflow.retry").click());
  expect(mocks.action).toHaveBeenCalledWith("personal", "run", "retry", undefined);
  expect(button("agent.workflow.approve")).toBeTruthy();
});
it("a late approval after a profile change never refreshes or navigates the new profile", async () => {
  await render(); let finish!: (value: unknown) => void;
  mocks.action.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => button("agent.workflow.approve").click()); mocks.current.mockReturnValue(false);
  await act(async () => finish({ ...run, status: "completed", actions: [{ kind: "tasks", status: "completed", resourceIds: ["saved-task"], errorCode: null }] }));
  expect(mocks.refresh).not.toHaveBeenCalled(); expect(mocks.refreshNotes).not.toHaveBeenCalled(); expect(mocks.navigateTask).not.toHaveBeenCalled();
});

it("lost approval and failed reconciliation disable further writes until status is checked", async () => {
  await render(); mocks.action.mockRejectedValue(new Error("offline")); mocks.get.mockRejectedValue(new Error("offline"));
  await act(async () => button("agent.workflow.approve").click());
  expect(button("agent.workflow.approve").disabled).toBe(true);
  expect(button("agent.workflow.checkResults")).toBeTruthy(); expect(mocks.action).toHaveBeenCalledTimes(1);
  mocks.get.mockResolvedValue({ ...run, status: "completed", actions: [{ kind: "note", status: "completed", resourceIds: ["created-note"], errorCode: null }] });
  await act(async () => button("agent.workflow.checkResults").click());
  expect(button("agent.workflow.approve")).toBeUndefined(); expect(button("agent.workflow.openNote")).toBeTruthy();
  expect(mocks.action).toHaveBeenCalledTimes(1);
});

function withTasks(): AgentWorkflow {
  return { ...run, preview: { ...run.preview!, tasks: { previewId: "preview", timezone: "Asia/Shanghai", warnings: [], tasks: ["First", "Second"].map((title, index) => ({ clientId: `task-${index}`, title, description: "Draft", priority: 2, startDate: null, dueDate: null, dueAt: null, projectId: null, repeatRule: "none", repeatInterval: 1, repeatEndDate: null, repeatEndCount: null, reason: "", warnings: [], duplicateOf: [] })) } } };
}
async function changeTitle(value: string) {
  const input = host.querySelector<HTMLInputElement>('[aria-label="taskComposer.taskTitle 1"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("task edits and exclusion require reviewed server drafts and the new token before creation", async () => {
  const original = withTasks(); mocks.get.mockResolvedValue(original); await render();
  await changeTitle("User-reviewed title");
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="taskComposer.select 2"]')!.click());
  expect(button("agent.workflow.approve").disabled).toBe(true);
  expect(mocks.action).not.toHaveBeenCalled(); expect(mocks.reviseTasks).not.toHaveBeenCalled();
  const reviewed = { ...original, preview: { ...original.preview!, token: "b".repeat(64), tasks: { ...original.preview!.tasks!, tasks: original.preview!.tasks!.tasks.map((task, index) => ({ ...task, title: index ? task.title : "User-reviewed title", selected: !index })) } } };
  mocks.reviseTasks.mockResolvedValue(reviewed);
  await act(async () => button("agent.workflow.reviewTasks").click());
  const sent = mocks.reviseTasks.mock.calls[0];
  expect(sent.slice(0, 2)).toEqual(["personal", "run"]);
  expect(sent[2].token).toBe(original.preview!.token);
  expect(sent[2].tasks[0].title).toBe("User-reviewed title"); expect(sent[2].tasks[1].selected).toBe(false);
  expect(sent[2].tasks[0]).not.toHaveProperty("projectId"); expect(sent[2].tasks[0]).not.toHaveProperty("allowDuplicate");
  expect(mocks.action).not.toHaveBeenCalled(); expect(button("agent.workflow.approve").disabled).toBe(false);
  await act(async () => button("agent.workflow.approve").click());
  expect(mocks.action).toHaveBeenCalledWith("personal", "run", "approve", reviewed.preview.token);
});

it("invalid reviews retain local edits and discard restores the last server preview", async () => {
  mocks.get.mockResolvedValue(withTasks()); await render(); await changeTitle("Still unsaved");
  mocks.reviseTasks.mockRejectedValue({ code: "INVALID_DATE_RANGE" });
  await act(async () => button("agent.workflow.reviewTasks").click());
  expect(host.querySelector<HTMLInputElement>('[aria-label="taskComposer.taskTitle 1"]')!.value).toBe("Still unsaved");
  expect(button("agent.workflow.approve").disabled).toBe(true);
  await act(async () => button("agent.workflow.discardTaskChanges").click());
  expect(host.querySelector<HTMLInputElement>('[aria-label="taskComposer.taskTitle 1"]')!.value).toBe("First");
  expect(button("agent.workflow.approve").disabled).toBe(false);
});

it("a lost review response reconciles by GET without replay or creation", async () => {
  const original = withTasks(); mocks.get.mockResolvedValue(original); await render(); await changeTitle("Reviewed remotely");
  mocks.reviseTasks.mockRejectedValue(new Error("offline"));
  mocks.get.mockResolvedValue({ ...original, preview: { ...original.preview!, token: "c".repeat(64) } });
  await act(async () => button("agent.workflow.reviewTasks").click());
  expect(mocks.reviseTasks).toHaveBeenCalledTimes(1); expect(mocks.action).not.toHaveBeenCalled();
  expect(button("agent.workflow.approve").disabled).toBe(false);
  await act(async () => button("agent.workflow.approve").click());
  expect(mocks.action).toHaveBeenCalledWith("personal", "run", "approve", "c".repeat(64));
});

it("a late task review cannot update a different profile or trigger creation", async () => {
  mocks.get.mockResolvedValue(withTasks()); await render(); await changeTitle("Local edit");
  let finish!: (value: AgentWorkflow) => void;
  mocks.reviseTasks.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => button("agent.workflow.reviewTasks").click());
  mocks.current.mockReturnValue(false);
  await act(async () => finish({ ...run, preview: { ...run.preview!, token: "d".repeat(64) } }));
  expect(host.querySelector<HTMLInputElement>('[aria-label="taskComposer.taskTitle 1"]')!.value).toBe("Local edit");
  expect(mocks.action).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled();
});

it("failed task review reconciliation disables writes until execution status is checked", async () => {
  const original = withTasks(); mocks.get.mockResolvedValue(original); await render(); await changeTitle("Uncertain review");
  mocks.reviseTasks.mockRejectedValue(new Error("offline")); mocks.get.mockRejectedValue(new Error("offline"));
  await act(async () => button("agent.workflow.reviewTasks").click());
  expect(button("agent.workflow.approve").disabled).toBe(true); expect(button("agent.workflow.reviewTasks").disabled).toBe(true);
  mocks.get.mockResolvedValue({ ...original, preview: { ...original.preview!, token: "e".repeat(64) } });
  await act(async () => button("agent.workflow.checkResults").click());
  expect(button("agent.workflow.approve").disabled).toBe(false);
  expect(mocks.reviseTasks).toHaveBeenCalledTimes(1); expect(mocks.action).not.toHaveBeenCalled();
});
