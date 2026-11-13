import React, { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NoteList from "../NoteList";
import { revealKnowledgeTreeNote } from "@/lib/knowledgeTreeCreateVisibility";
import type { Note, NoteListItem } from "@/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mock = vi.hoisted(() => ({
  state: {} as ReturnType<typeof import("@/store/AppContext")["useApp"]>["state"],
  listeners: new Set<() => void>(),
  getNotes: vi.fn(),
  t: (key: string) => key,
}));
function update(patch: Partial<typeof mock.state>) {
  mock.state = { ...mock.state, ...patch };
  mock.listeners.forEach((listener) => listener());
}
const actions = {
  setNotes: (notes: NoteListItem[]) => update({ notes }),
  setLoading: (isLoading: boolean) => update({ isLoading }),
  refreshNotes: vi.fn(), refreshNotebooks: vi.fn(),
};
vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: useSyncExternalStore(
    (listener) => { mock.listeners.add(listener); return () => { mock.listeners.delete(listener); }; },
    () => mock.state,
  ) }),
  useAppActions: () => actions,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mock.t }) }));
vi.mock("@/lib/api", () => ({
  api: { getNotes: mock.getNotes, getSharedNoteIds: async () => [] },
  getCurrentWorkspace: () => "personal", getServerUrl: () => "", getBaseUrl: () => "",
  isNativeCapacitor: () => false, isAndroidInvalidServerUrl: () => false, broadcastLogout: vi.fn(),
}));
vi.mock("@/lib/knowledgeTreeApi", () => ({ knowledgeTreeApi: {
  list: async () => ({ nodes: [] }), listShared: async () => ({ nodes: [] }),
} }));
vi.mock("@/hooks/useUserPreferences", () => ({ useUserPreferences: () => ({
  prefs: { showNoteListUpdatedTime: true, showNoteListDividers: false, noteListTitleOnly: false }, setPref: vi.fn(),
}) }));
vi.mock("@/hooks/useNoteLoader", () => ({ useNoteLoader: () => ({ loadNote: vi.fn(), cancelNoteLoad: vi.fn() }) }));
vi.mock("@/lib/realtime", () => ({ realtime: { connect: vi.fn(), on: () => () => {} } }));
vi.mock("@/lib/exportService", () => ({}));
vi.mock("@/components/CreateNoteMenu", () => ({ default: () => null }));
vi.mock("@/components/ContextMenu", () => ({ default: () => null }));
vi.mock("@/components/ShareModal", () => ({ default: () => null }));
vi.mock("@/components/KnowledgeTreePermissionsDialog", () => ({ default: () => null }));
vi.mock("framer-motion", () => ({
  motion: { div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & {
    initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown; layout?: unknown; layoutDependency?: unknown;
  }>(({ initial, animate, exit, transition, layout, layoutDependency, ...props }, ref) => {
    void [initial, animate, exit, transition, layout, layoutDependency];
    return <div ref={ref} {...props} />;
  }) },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}));

function note(index: number): NoteListItem {
  return {
    id: `note-${index}`, userId: "owner", notebookId: "folder", workspaceId: null,
    title: `文档 ${index}`, contentText: "正文", sortOrder: index,
    isPinned: 0, isFavorite: 0, isLocked: 0, isArchived: 0, isTrashed: 0,
    version: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01",
  };
}

describe("three-column note list reveal", () => {
  let root: Root;
  let host: HTMLDivElement;
  let scrolled: string[];
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mock.listeners.clear();
    mock.state = {
      viewMode: "notebook", selectedNotebookId: "folder", selectedKnowledgeTreeParentId: "parent",
      selectedTagIds: [], searchQuery: "", notes: [], notebooks: [], tags: [],
      activeNote: null, isLoading: false, noteListCollapsed: false, notesRefreshToken: 0,
      noteLoadingState: { pendingNoteId: null },
    } as unknown as typeof mock.state;
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    scrolled = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: function (this: HTMLElement) {
      scrolled.push(this.dataset.noteListNoteId || "");
    } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("waits for the selected directory response, then reveals once and allows explicit repeat reveal", async () => {
    mock.getNotes.mockResolvedValueOnce([note(0)]);
    await act(async () => root.render(<NoteList />));
    let finish!: (notes: NoteListItem[]) => void;
    mock.getNotes.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => {
      update({ activeNote: note(40) as Note, selectedKnowledgeTreeParentId: "another-parent" });
      revealKnowledgeTreeNote("note-40", false);
    });
    expect(mock.getNotes).toHaveBeenLastCalledWith(expect.objectContaining({ treeParentId: "another-parent", includeDescendants: "0" }));
    expect(scrolled).toEqual([]);
    await act(async () => finish([note(0), note(40)]));
    expect(scrolled).toEqual(["note-40"]);
    await act(async () => update({ activeNote: { ...note(40), version: 2 } as Note, notes: [note(0), { ...note(40), title: "保存后" }] }));
    expect(scrolled).toEqual(["note-40"]);
    await act(async () => revealKnowledgeTreeNote("note-40"));
    expect(scrolled).toEqual(["note-40", "note-40"]);
  });

  it("reveals an offscreen virtual row and preserves manual scroll during saves and refreshes", async () => {
    const notes = Array.from({ length: 200 }, (_, index) => note(index));
    mock.getNotes.mockResolvedValue(notes);
    await act(async () => root.render(<NoteList />));
    const viewport = host.querySelector<HTMLElement>('[data-note-list-scroll-viewport="virtual"]')!;
    expect(host.querySelector('[data-note-list-note-id="note-175"]')).toBeNull();
    await act(async () => update({ activeNote: note(175) as Note }));
    expect(viewport.scrollTop).toBe(13480);
    expect(host.querySelector('[data-note-list-note-id="note-175"]')).not.toBeNull();
    await act(async () => { viewport.scrollTop = 2000; viewport.dispatchEvent(new Event("scroll", { bubbles: true })); });
    await act(async () => update({ activeNote: { ...note(175), version: 2 } as Note, notes: [...notes] }));
    expect(viewport.scrollTop).toBe(2000);
    await act(async () => update({ notesRefreshToken: 1 }));
    expect(viewport.scrollTop).toBe(2000);
    await act(async () => revealKnowledgeTreeNote("note-175", false));
    expect(viewport.scrollTop).toBe(13480);
  });

  it("clears an incompatible date filter when explicitly locating a document", async () => {
    mock.getNotes.mockResolvedValue([note(0)]);
    await act(async () => root.render(<NoteList />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="noteList.calendarTitle"]')!.click());
    const date = host.querySelector<HTMLButtonElement>('button[aria-label^="20"]')!;
    await act(async () => date.click());
    expect(host.querySelector('[data-note-list-note-id="note-0"]')).toBeNull();
    await act(async () => revealKnowledgeTreeNote("note-0", false));
    expect(host.querySelector('[data-note-list-note-id="note-0"]')).not.toBeNull();
    expect(scrolled).toEqual(["note-0"]);
  });
});
