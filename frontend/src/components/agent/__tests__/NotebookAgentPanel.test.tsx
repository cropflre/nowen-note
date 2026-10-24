import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { AgentWorkflow } from "@/lib/agentWorkflow";
const mocks = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), create: vi.fn(), action: vi.fn(), capabilities: vi.fn(), books: vi.fn(),
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
