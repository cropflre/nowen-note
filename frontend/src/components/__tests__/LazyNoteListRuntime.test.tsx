import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LazyNoteListRuntime from "../LazyNoteListRuntime";

const store = vi.hoisted(() => ({
  state: {
    viewMode: "notebook", selectedNotebookId: "folder", selectedKnowledgeTreeParentId: "folder",
    isLoading: false, notes: [] as { id: string }[],
  },
  actions: { setNotes: vi.fn(), refreshNotes: vi.fn() },
}));
vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: store.state }), useAppActions: () => store.actions,
}));
vi.mock("../NoteList", () => ({
  default: ({ directorySearchActive }: { directorySearchActive: boolean }) => (
    <div>
      <div data-note-list-desktop-header><h2>技术学习</h2><button>列表选项</button></div>
      <span data-search-active={String(directorySearchActive)} />
    </div>
  ),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("directory search in the list header", () => {
  let root: Root;
  let host: HTMLDivElement;
  const notes = [
    { id: "one", title: "React 学习", contentText: "components", notebookId: "folder" },
    { id: "two", title: "其他笔记", contentText: "notes", notebookId: "folder" },
  ];
  beforeEach(() => {
    store.state.viewMode = "notebook";
    store.state.selectedNotebookId = "folder";
    store.state.selectedKnowledgeTreeParentId = "folder";
    store.state.notes = [...notes];
    store.actions.setNotes.mockReset().mockImplementation((next) => { store.state.notes = next; });
    store.actions.refreshNotes.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
  });
  const render = () => act(async () => { root.render(<LazyNoteListRuntime />); });
  async function search(value: string) {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="搜索本目录文档"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("mounts search after the title and actions; clearing restores the list and active status", async () => {
    await render();
    const header = host.querySelector<HTMLElement>("[data-note-list-desktop-header]")!;
    expect(header.lastElementChild?.hasAttribute("data-note-directory-search")).toBe(true);
    expect(header.querySelector("h2")?.textContent).toBe("技术学习");
    expect(header.querySelector("button")?.textContent).toBe("列表选项");
    await search("React");
    expect(store.state.notes.map((note) => note.id)).toEqual(["one"]);
    expect(host.querySelector('[data-search-active="true"]')).not.toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="清空本目录搜索"]')!.click(); });
    expect(store.state.notes.map((note) => note.id)).toEqual(["one", "two"]);
    expect(host.querySelector('[data-search-active="false"]')).not.toBeNull();
    expect(store.actions.refreshNotes).toHaveBeenCalledOnce();
  });

  it("shows zero matches and lets Escape clear the query", async () => {
    await render();
    await search("missing");
    expect(store.state.notes).toHaveLength(0);
    expect(host.querySelector('[data-search-active="true"]')).not.toBeNull();
    expect(host.querySelector("[data-note-directory-search]")?.getAttribute("title")).toContain("匹配 0 篇");
    await act(async () => {
      host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(store.state.notes).toHaveLength(2);
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("");
  });

  it("clears search on a directory change and hides the local search in global search view", async () => {
    await render();
    await search("React");
    store.state.selectedNotebookId = "another";
    store.state.selectedKnowledgeTreeParentId = "another";
    store.state.notes = [notes[1]];
    await render();
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("");
    expect(store.state.notes.map((note) => note.id)).toEqual(["two"]);
    store.state.viewMode = "search";
    await render();
    expect(host.querySelector("[data-note-directory-search]")).toBeNull();
  });
});
