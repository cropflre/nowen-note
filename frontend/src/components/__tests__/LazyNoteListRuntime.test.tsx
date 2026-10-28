import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LazyNoteListRuntime from "../LazyNoteListRuntime";
import type { NoteListItem } from "@/types";

const store = vi.hoisted(() => ({
  state: {
    viewMode: "notebook", selectedNotebookId: "folder", selectedKnowledgeTreeParentId: "folder",
    isLoading: false, notes: [] as Pick<NoteListItem, "id" | "title" | "contentText" | "notebookId">[],
  },
  actions: { setNotes: vi.fn(), refreshNotes: vi.fn() },
}));
vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: store.state }), useAppActions: () => store.actions,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
    store.state.isLoading = false;
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
    const input = host.querySelector<HTMLInputElement>("input")!;
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

  it("searches favorite titles and previews across folders without changing the view", async () => {
    store.state.viewMode = "favorites";
    store.state.selectedNotebookId = "";
    store.state.notes = [notes[0], { ...notes[1], notebookId: "another" }];
    await render();
    expect(host.querySelector('input[aria-label="noteList.searchFavorites"]')).not.toBeNull();
    await search("REACT components");
    expect(store.state.notes.map((note) => note.id)).toEqual(["one"]);
    await search("notes");
    expect(store.state.notes.map((note) => note.id)).toEqual(["two"]);
    expect(store.state.viewMode).toBe("favorites");
    expect(host.querySelector('[data-search-active="true"]')).not.toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="noteList.clearFavoritesSearch"]')!.click(); });
    expect(store.state.notes.map((note) => note.id)).toEqual(["one", "two"]);
    expect(store.actions.refreshNotes).toHaveBeenCalledOnce();
  });

  it("clears a zero-match favorites search with Escape", async () => {
    store.state.viewMode = "favorites";
    await render();
    await search("missing");
    expect(store.state.notes).toHaveLength(0);
    expect(host.querySelector('[data-search-active="true"]')).not.toBeNull();
    await act(async () => {
      host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(store.state.notes).toHaveLength(2);
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("");
  });

  it("clears the query between favorites and folders without restoring the previous scope", async () => {
    store.state.viewMode = "favorites";
    await render();
    await search("React");
    store.state.viewMode = "notebook";
    store.state.notes = [notes[1]];
    await render();
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("");
    expect(store.state.notes.map((note) => note.id)).toEqual(["two"]);
    await search("notes");
    store.state.viewMode = "favorites";
    store.state.notes = [notes[0]];
    await render();
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("");
    expect(store.state.notes.map((note) => note.id)).toEqual(["one"]);
  });

  it("reapplies favorites search after refresh and does not restore removed favorites", async () => {
    store.state.viewMode = "favorites";
    await render();
    await search("React");
    store.state.isLoading = true;
    await render();
    store.state.notes = [{ ...notes[1], title: "React 新收藏" }];
    store.state.isLoading = false;
    await render();
    expect(store.state.notes.map((note) => note.id)).toEqual(["two"]);
    await search("");
    expect(store.state.notes.map((note) => note.id)).toEqual(["two"]);
  });

  it("prevents manual reordering of a filtered favorites subset", async () => {
    store.state.viewMode = "favorites";
    await render();
    await search("React");
    const drag = new Event("dragstart", { bubbles: true, cancelable: true });
    host.querySelector("[data-note-list-desktop-header]")!.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
    await search("");
    const unfilteredDrag = new Event("dragstart", { bubbles: true, cancelable: true });
    host.querySelector("[data-note-list-desktop-header]")!.dispatchEvent(unfilteredDrag);
    expect(unfilteredDrag.defaultPrevented).toBe(false);
  });
});
