// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
const mocks = vi.hoisted(() => ({ folders: vi.fn(), prompts: vi.fn(), contributions: vi.fn(), compose: vi.fn(), save: vi.fn(), createFolder: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { getNotebooks: mocks.folders, createNotebook: mocks.createFolder, aiPrompts: { list: mocks.prompts } }, getCurrentWorkspace: () => "personal", getBaseUrl: () => "/api" }));
vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: { selectedNotebookId: "current" } }) }));
vi.mock("@/lib/pluginApi", () => ({ pluginApi: { contributions: mocks.contributions } }));
vi.mock("@/lib/aiCollaboration", async () => ({ ...await vi.importActual<typeof import("@/lib/aiCollaboration")>("@/lib/aiCollaboration"), collaborationRequest: mocks.compose, saveCollaborationNote: mocks.save }));
import Dialog from "../aiCollaboration/AICollaborationDialog";
import { collaborationDraftKey, collaborationScope } from "@/lib/aiCollaboration";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const button = (text: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent === text)!;
const typeIdea = async (value: string) => {
  const input = host.querySelector('textarea[aria-label="想法或工作需求"]') as HTMLTextAreaElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
};
beforeEach(async () => {
  localStorage.clear(); vi.clearAllMocks(); await i18n.changeLanguage("zh-CN");
  mocks.folders.mockResolvedValue([{ id: "other", name: "Other", permission: "write" }, { id: "current", name: "Current", permission: "write" }]);
  mocks.prompts.mockResolvedValue({ items: [] }); mocks.contributions.mockResolvedValue([]);
  mocks.compose.mockResolvedValue({ content: "# 整理后的想法\n\n可执行的下一步", references: [], truncated: false });
  mocks.save.mockImplementation(async request => request); mocks.createFolder.mockResolvedValue({ id: "quick", name: "快速记录" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function mount() { await act(async () => root.render(<Dialog scope={collaborationScope()} onClose={() => {}} />)); await flush(); }
describe("simple AI capture", () => {
  it("writes, organizes and saves without opening any settings", async () => {
    await mount(); expect(host.querySelector("details")!.open).toBe(false);
    await typeIdea("想加一个周报功能"); expect(button("帮我整理").disabled).toBe(false);
    await act(async () => button("帮我整理").click()); await flush();
    expect(mocks.compose).toHaveBeenCalledWith("compose", expect.objectContaining({ input: "想加一个周报功能", intent: "capture" }), expect.anything());
    expect(mocks.compose.mock.calls[0][1].notebookId).toBeUndefined();
    expect(host.querySelector("details")!.open).toBe(false);
    await act(async () => button("保存笔记").click()); await flush();
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ notebookId: "current", title: "整理后的想法", content: expect.stringContaining("想加一个周报功能") }), collaborationScope());
  });
  it("does not wait for template services and can save the original without AI", async () => {
    mocks.prompts.mockImplementation(() => new Promise(() => {})); mocks.contributions.mockImplementation(() => new Promise(() => {}));
    await mount(); await typeIdea("先记下来"); expect(button("直接记下").disabled).toBe(false);
    await act(async () => button("直接记下").click()); await flush();
    expect(mocks.compose).not.toHaveBeenCalled(); expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ content: "先记下来" }), collaborationScope());
  });
  it("selects a suitable built-in method from the request automatically", async () => {
    await mount(); await typeIdea("根据项目现状写一份策划书"); await act(async () => button("帮我整理").click()); await flush();
    expect(mocks.compose.mock.calls[0][1]).toMatchObject({ intent: "draft", skill: { kind: "prompt", name: "项目策划书" } });
  });
  it("creates a normal quick-note folder at save time for a fresh account", async () => {
    mocks.folders.mockResolvedValue([]); await mount(); await typeIdea("第一条想法");
    await act(async () => button("直接记下").click()); await flush();
    expect(mocks.createFolder).toHaveBeenCalledWith({ name: "快速记录" }); expect(mocks.save.mock.calls[0][0].notebookId).toBe("quick");
  });
  it("keeps the input and frozen save request after a failed save", async () => {
    mocks.save.mockRejectedValue(new Error("offline")); await mount(); await typeIdea("不能丢的想法");
    await act(async () => button("直接记下").click()); await flush();
    const firstId = mocks.save.mock.calls[0][0].id;
    expect(JSON.parse(localStorage.getItem(collaborationDraftKey(collaborationScope()))!).input).toBe("不能丢的想法");
    await act(async () => button("重试同一笔保存").click()); await flush();
    expect(mocks.save.mock.calls[1][0].id).toBe(firstId);
  });
  it("preserves an unreadable old draft instead of overwriting it", async () => {
    const key = collaborationDraftKey(collaborationScope()); localStorage.setItem(key, "broken original draft");
    await mount(); await typeIdea("new idea"); expect(localStorage.getItem(key)).toBe("broken original draft");
  });
});
