import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KnowledgeTreeInlineRename from "../KnowledgeTreeInlineRename";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mock = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), remove: vi.fn(),
  state: { activeNote: { id: "note-new", title: "测试模板", content: "local unsaved body", version: 1, updatedAt: "2026-01-01" } },
  actions: { setActiveNote: vi.fn(), updateNoteInList: vi.fn(), updateNoteTab: vi.fn(), refreshNotes: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api: { getNote: mock.get, updateNote: mock.update, deleteNote: mock.remove } }));
vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: mock.state }), useAppActions: () => mock.actions }));
const node = { id: "node-new", resourceId: "note-new", resourceType: "note", title: "测试模板" } as KnowledgeTreeNode;

describe("template inline rename", () => {
  let root: Root;
  let host: HTMLDivElement;
  const saved = vi.fn();
  const cancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mock.get.mockResolvedValue({ id: "note-new", version: 1 });
    mock.update.mockResolvedValue({ id: "note-new", title: "261111-011", content: "server snapshot body", version: 2, updatedAt: "2026-01-02" });
    mock.state.activeNote = { id: "note-new", title: "测试模板", content: "local unsaved body", version: 1, updatedAt: "2026-01-01" };
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    HTMLElement.prototype.scrollIntoView = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => root.render(<KnowledgeTreeInlineRename node={node} onSaved={saved} onCancel={cancel} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    return host.querySelector<HTMLInputElement>("input")!;
  }

  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function confirm() {
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="确认重命名"]')!.click());
  }

  it("selects the whole template title and saves only the renamed existing document", async () => {
    const input = await render();
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, node.title.length]);
    await type(input, " 261111-011 ");
    await confirm();
    expect(mock.update).toHaveBeenCalledTimes(1);
    expect(mock.get).toHaveBeenCalledWith("note-new");
    expect(mock.update).toHaveBeenCalledWith("note-new", { title: "261111-011", version: 1 });
    expect(saved).toHaveBeenCalledWith("261111-011");
    expect(mock.actions.setActiveNote).toHaveBeenCalledWith({ id: "note-new", title: "261111-011", content: "local unsaved body", version: 2, updatedAt: "2026-01-02" });
    expect(mock.actions.updateNoteInList).toHaveBeenCalledWith({ id: "note-new", title: "261111-011", version: 2, updatedAt: "2026-01-02" });
    expect(mock.actions.updateNoteTab).toHaveBeenCalledWith({ id: "note-new", title: "261111-011", version: 2, updatedAt: "2026-01-02" });
    expect(mock.remove).not.toHaveBeenCalled();
  });

  it("rejects empty names without writing or losing the created document", async () => {
    const input = await render();
    await type(input, " ");
    await confirm();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("名称不能为空");
    expect(mock.update).not.toHaveBeenCalled();
    expect(mock.remove).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });

  it("DCC-002: failed template rename preserves the typed name for retry and the created document", async () => {
    mock.update.mockRejectedValueOnce(new Error("没有权限"));
    const input = await render();
    await type(input, "261111-011");
    await confirm();
    expect(input.value).toBe("261111-011");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("没有权限");
    expect(mock.actions.setActiveNote).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    expect(mock.remove).not.toHaveBeenCalled();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(document.activeElement).toBe(input);
    await confirm();
    expect(saved).toHaveBeenCalledWith("261111-011");
  });

  it("Escape and cancel keep the created document without a delete or rename", async () => {
    const input = await render();
    await type(input, "261111-011");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(cancel).toHaveBeenCalledOnce();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="取消重命名"]')!.click());
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(mock.update).not.toHaveBeenCalled();
    expect(mock.remove).not.toHaveBeenCalled();
  });

  it("does not replace another active document while the rename request finishes", async () => {
    let finish!: (value: Record<string, unknown>) => void;
    mock.update.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const input = await render();
    await type(input, "261111-011");
    await confirm();
    mock.state.activeNote = { id: "other-note", title: "另一篇", content: "other body", version: 1, updatedAt: "2026-01-01" };
    await act(async () => root.render(<KnowledgeTreeInlineRename node={node} onSaved={saved} onCancel={cancel} />));
    await act(async () => finish({ id: "note-new", title: "261111-011", version: 2, updatedAt: "2026-01-02" }));
    expect(mock.actions.setActiveNote).not.toHaveBeenCalled();
    expect(mock.actions.updateNoteTab).toHaveBeenCalledWith({ id: "note-new", title: "261111-011", version: 2, updatedAt: "2026-01-02" });
  });

  it("keeps a newer local version and body when an older rename response arrives", async () => {
    let finish!: (value: Record<string, unknown>) => void;
    mock.update.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const input = await render();
    await type(input, "261111-011");
    await confirm();
    mock.state.activeNote = { id: "note-new", title: "newer confirmed title", content: "newest local body", version: 3, updatedAt: "2026-01-03" };
    await act(async () => root.render(<KnowledgeTreeInlineRename node={node} onSaved={saved} onCancel={cancel} />));
    await act(async () => finish({ id: "note-new", title: "261111-011", content: "old body", version: 2, updatedAt: "2026-01-02" }));
    expect(mock.actions.setActiveNote).not.toHaveBeenCalled();
    expect(mock.actions.updateNoteInList).toHaveBeenCalledWith({ id: "note-new", title: "newer confirmed title", version: 3, updatedAt: "2026-01-03" });
    expect(saved).toHaveBeenCalledWith("newer confirmed title");
  });
});
