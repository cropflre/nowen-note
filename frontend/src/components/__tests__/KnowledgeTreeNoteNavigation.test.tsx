import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KnowledgeTreePanel from "../KnowledgeTreePanel";
import MobileKnowledgeTreePanel from "../MobileKnowledgeTreePanel";
import { AppProvider, useApp, useAppActions } from "@/store/AppContext";
import { useNoteLoader } from "@/hooks/useNoteLoader";
import { primaryNoteLoadCoordinator } from "@/lib/noteLoadCoordinator";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import type { Note } from "@/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({ list: vi.fn(), getNote: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { getNote: mocks.getNote },
  getCurrentWorkspace: () => null,
  getServerUrl: () => "http://localhost",
}));
vi.mock("@/lib/knowledgeTreeApi", () => ({
  knowledgeTreeApi: { list: mocks.list, listShared: async () => ({ nodes: [] }) },
}));
// Keep the real loader/coordinator and activation guard; isolate note storage/network IO.
vi.mock("@/lib/noteLoadSource", () => ({
  loadNoteCacheFirst: ({ fetchRemote }: { fetchRemote: () => Promise<Note> }) => fetchRemote(),
}));
vi.mock("@/lib/toast", () => ({ toast: { error: mocks.error } }));
vi.mock("@/components/KnowledgeTreeCreateMenuRuntime", () => ({ KnowledgeTreeCreateDropdown: () => null }));
vi.mock("@/components/KnowledgeTreeNodeMenu", () => ({ default: () => null }));
vi.mock("@/components/KnowledgeTreePermissionsDialog", () => ({ default: () => null }));
vi.mock("@/components/NoteTemplatePickerDialog", () => ({ default: () => null }));
vi.mock("@/components/FolderPasswordDialog", () => ({ default: () => null }));
vi.mock("@/components/attachmentDetail/AttachmentDetailDrawer", () => ({ default: () => null }));
vi.mock("@/components/knowledgeTreeImport", () => ({}));

function note(id: string): Note {
  return {
    id, userId: "owner", title: id, notebookId: "notebook", workspaceId: null,
    content: `Content of ${id}`, contentText: `Content of ${id}`, contentFormat: "markdown",
    isPinned: 0, isFavorite: 0, isLocked: 0, isArchived: 0, isTrashed: 0,
    version: 1, sortOrder: 0, createdAt: "2026-11-11", updatedAt: "2026-11-11",
  } as Note;
}

function node(id: string): KnowledgeTreeNode {
  return {
    id: `note:${id}`, parentId: null, title: id, resourceId: id,
    userId: "owner", workspaceId: null, scopeKey: "personal:owner",
    nodeType: "markdown", resourceType: "note", sortOrder: 0,
    isDeleted: 0, isExpanded: 0, childCount: 0, createdAt: "2026-11-11", updatedAt: "2026-11-11",
    access: { nodeId: `note:${id}`, rolePreset: "editor", source: "inherited", sourceNodeId: null,
      capabilities: { canView: true, canCreate: true, canEdit: true, canComment: true,
        canMove: false, canDelete: false, canDownload: true, canReshare: false, canManageMembers: false } },
  };
}

describe.each(["tree", "desktop quick", "mobile quick"])("%s note navigation", (surface) => {
  let root: Root;
  let host: HTMLDivElement;
  let context: ReturnType<typeof useApp>;
  let actions: ReturnType<typeof useAppActions>;
  let loader: ReturnType<typeof useNoteLoader>;

  function Harness() {
    context = useApp();
    actions = useAppActions();
    loader = useNoteLoader();
    return surface === "tree" ? <KnowledgeTreePanel />
      : <MobileKnowledgeTreePanel variant={surface === "mobile quick" ? "mobile" : "desktop"} />;
  }

  async function clickNote(id: string) {
    const row = host.querySelector<HTMLElement>(`[data-knowledge-tree-select-id="note:${id}"]`);
    expect(row).not.toBeNull();
    await act(async () => row!.querySelector<HTMLElement>("[data-knowledge-tree-title]")!.click());
  }

  beforeEach(async () => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    mocks.list.mockResolvedValue({ nodes: [node("A"), node("B"), node("C")] });
    mocks.getNote.mockImplementation(async (id: string) => note(id));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<AppProvider><Harness /></AppProvider>));
    await act(async () => {
      actions.setActiveNote(note("A"));
      actions.openNoteTab(note("A"));
    });
  });

  afterEach(async () => {
    await act(async () => {
      primaryNoteLoadCoordinator.cancel();
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  });

  it("reactivates the existing A tab after following a link from A to B", async () => {
    // EditorPane's internal-link entry point uses this same loader and activation action.
    await act(async () => {
      await loader.loadNote({
        noteId: "B", summary: note("B"), request: () => mocks.getNote("B"),
        onSuccess: (target) => { actions.setActiveNote(target); actions.openNoteTab(target); },
      });
    });
    expect(context.state.activeNote?.id).toBe("B");

    await clickNote("A");

    expect(context.state.activeNote?.id).toBe("A");
    expect(context.state.openNoteTabs.map((tab) => tab.id)).toEqual(["A", "B"]);
    expect(context.state.selectedKnowledgeTreeParentId).toBeNull();
    // A late save acknowledgement from the editor just left must still be ignored.
    await act(async () => actions.setActiveNote({ ...note("B"), version: 2 }));
    expect(context.state.activeNote?.id).toBe("A");
  });

  it("opens and activates a new tab and flushes the old editor before requesting it", async () => {
    const beforeSwitch = vi.fn();
    window.addEventListener("nowen:before-note-switch", beforeSwitch);
    mocks.getNote.mockImplementation(async (id: string) => {
      expect(beforeSwitch).toHaveBeenCalledOnce();
      return note(id);
    });
    try {
      await clickNote("C");
      expect(context.state.activeNote?.id).toBe("C");
      expect(context.state.openNoteTabs.map((tab) => tab.id)).toEqual(["A", "C"]);
      expect(context.state.noteLoadingState.pendingNoteId).toBeNull();
      expect(mocks.error).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("nowen:before-note-switch", beforeSwitch);
    }
  });

  it("keeps the last tree selection when earlier requests finish later", async () => {
    let finishB!: (value: Note) => void;
    mocks.getNote.mockImplementation((id: string) => id === "B"
      ? new Promise<Note>((resolve) => { finishB = resolve; }) : Promise.resolve(note(id)));

    await clickNote("B");
    await clickNote("C");
    expect(context.state.activeNote?.id).toBe("C");
    await act(async () => finishB(note("B")));

    expect(context.state.activeNote?.id).toBe("C");
    expect(context.state.openNoteTabs.map((tab) => tab.id)).toEqual(["A", "C"]);
  });

  it("can open a newly created note after selecting the already active tree note", async () => {
    await clickNote("A");
    await act(async () => actions.setActiveNote(note("created")));

    expect(context.state.activeNote?.id).toBe("created");
    expect(mocks.getNote).not.toHaveBeenCalled();
  });

  it("cancels a pending switch when the user selects the still active note", async () => {
    let finishB!: (value: Note) => void;
    mocks.getNote.mockImplementation(() => new Promise<Note>((resolve) => { finishB = resolve; }));
    await clickNote("B");
    expect(context.state.noteLoadingState.pendingNoteId).toBe("B");

    await clickNote("A");
    expect(context.state.noteLoadingState.pendingNoteId).toBeNull();
    await act(async () => finishB(note("B")));
    expect(context.state.activeNote?.id).toBe("A");
    expect(context.state.openNoteTabs.map((tab) => tab.id)).toEqual(["A"]);
  });

  it("clears a failed switch when the user selects the still active note", async () => {
    mocks.getNote.mockRejectedValueOnce(new Error("Open failed"));
    await clickNote("B");
    expect(context.state.noteLoadingState.error).toBe("Open failed");
    expect(context.state.activeNote?.id).toBe("A");

    await clickNote("A");
    expect(context.state.noteLoadingState.error).toBeNull();
    expect(context.state.noteLoadingState.pendingNoteId).toBeNull();
    expect(context.state.openNoteTabs.map((tab) => tab.id)).toEqual(["A"]);
  });
});
