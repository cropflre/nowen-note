// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  baseProps: null as any,
  snapshot: null as { content: string; contentText: string } | null,
  acknowledgeSave: vi.fn(),
  actions: {
    setActiveNote: vi.fn(),
    updateNoteInList: vi.fn(),
    updateNoteTab: vi.fn(),
    setSyncStatus: vi.fn(),
    setLastSynced: vi.fn(),
  },
}));

vi.mock("@/store/AppContext", () => ({
  useAppActions: () => fixture.actions,
}));

vi.mock("@/lib/draftStorage", () => ({
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
}));

vi.mock("@/lib/api.impl", () => ({
  api: {
    attachments: { upload: async () => ({}) },
    search: async () => [],
    moveNotebook: async () => ({}),
    reorderNotebooks: async () => ({}),
    updateNotebook: async () => ({}),
    createTask: async () => ({}),
    getHabitCheckinLog: async () => [],
  },
  getBaseUrl: () => "/api",
  getCurrentWorkspace: () => null,
  getServerUrl: () => "",
}));

vi.mock("../TiptapEditor", async () => {
  const ReactModule = await import("react");
  const Base = ReactModule.forwardRef((props: any, ref) => {
    fixture.baseProps = props;
    ReactModule.useImperativeHandle(ref, () => ({
      flushSave: vi.fn(),
      discardPending: vi.fn(),
      getSnapshot: () => fixture.snapshot,
      acknowledgeSave: fixture.acknowledgeSave,
      isReady: () => true,
      appendMarkdown: () => false,
    }));
    return ReactModule.createElement("div", { "data-base-tiptap": "" });
  });
  Base.displayName = "MockEmptyDocumentTiptapEditor";
  return { default: Base };
});

import TiptapEditorRuntime from "../TiptapEditorRuntime";
import { resolveEditorRuntimeDecision } from "@/lib/editorRuntimePolicy";
import {
  clearActiveEditorRuntimeDecision,
  setActiveEditorRuntimeDecision,
} from "@/lib/editorRuntimeStore";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function paragraph(blockId: string, text: string) {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [{ type: "text", text }] : [],
  };
}

function doc(content: unknown[]) {
  return JSON.stringify({ type: "doc", content });
}

function note(id: string) {
  return {
    id,
    title: "Empty document",
    content: doc([paragraph("blk_empty001", "Last text")]),
    contentText: "Last text",
    contentFormat: "tiptap-json",
    version: 1,
    updatedAt: "2026-07-23T09:00:00.000Z",
    notebookId: "notebook-1",
    workspaceId: null,
    isLocked: false,
    isTrashed: false,
    isPinned: false,
    isFavorite: false,
  } as any;
}

function optimizedDecision() {
  return resolveEditorRuntimeDecision({
    content: doc([paragraph("blk_perf0000", "x".repeat(220_000))]),
    contentFormat: "tiptap-json",
  });
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function emptyPatchResponse(current: any, serverContent: string) {
  return new Response(JSON.stringify({
    success: true,
    noteId: current.id,
    title: current.title,
    version: 2,
    updatedAt: "2026-07-23T10:00:00.000Z",
    content: serverContent,
    contentText: "",
    contentFormat: "tiptap-json",
    notebookId: current.notebookId,
    operationCount: 1,
    affectedBlockIds: ["blk_empty001", "blk_serverempty"],
    deletedBlockIds: ["blk_empty001"],
    createdBlocks: [{
      operationIndex: 1,
      clientId: null,
      blockId: "blk_serverempty",
    }],
    blocks: [{
      noteId: current.id,
      blockId: "blk_serverempty",
      blockType: "paragraph",
      parentBlockId: null,
      blockOrder: 0,
      plainText: "",
      contentHash: "hash",
      path: "0",
      startOffset: null,
      endOffset: null,
    }],
    indexUpdateMode: "full",
    indexUpdateKind: "full",
    indexedBlockIds: ["blk_serverempty"],
    contentChangedByNormalization: false,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  fixture.baseProps = null;
  fixture.snapshot = null;
  fixture.acknowledgeSave.mockClear();
  Object.values(fixture.actions).forEach((mock) => mock.mockClear());
  clearActiveEditorRuntimeDecision();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  clearActiveEditorRuntimeDecision();
  vi.restoreAllMocks();
});

describe("Tiptap empty document Block identity", () => {
  it("uses Block Patch and requests authoritative content replay when no newer input exists", async () => {
    const current = note("empty-note");
    const sentContent = doc([]);
    const serverContent = doc([paragraph("blk_serverempty", "")]);
    fixture.snapshot = { content: sentContent, contentText: "" };
    setActiveEditorRuntimeDecision(current.id, optimizedDecision());
    const wholeSave = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      emptyPatchResponse(current, serverContent),
    );

    await act(async () => {
      root.render(<TiptapEditorRuntime note={current} onUpdate={wholeSave} />);
    });
    await act(async () => {
      fixture.baseProps.onUpdate({
        title: current.title,
        content: sentContent,
        contentText: "",
        _noteId: current.id,
        _saveGeneration: 1,
      });
      await flushAsync();
    });

    expect(wholeSave).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      operations: [{ type: "delete", blockId: "blk_empty001" }],
    });
    expect(fixture.acknowledgeSave).toHaveBeenCalledWith({
      noteId: current.id,
      version: 2,
      content: serverContent,
      saveGeneration: 1,
      preserveLocalEditor: false,
    });
    expect(fixture.actions.setActiveNote).toHaveBeenCalledWith(expect.objectContaining({
      id: current.id,
      version: 2,
      content: serverContent,
    }));
  });

  it("preserves newer local typing and lets the queued patch reconcile against the server ID", async () => {
    const current = note("empty-note-typing");
    const sentContent = doc([]);
    const serverContent = doc([paragraph("blk_serverempty", "")]);
    fixture.snapshot = {
      content: doc([paragraph("blk_localtyped", "New typing")]),
      contentText: "New typing",
    };
    setActiveEditorRuntimeDecision(current.id, optimizedDecision());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyPatchResponse(current, serverContent));

    await act(async () => {
      root.render(<TiptapEditorRuntime note={current} onUpdate={vi.fn()} />);
    });
    await act(async () => {
      fixture.baseProps.onUpdate({
        title: current.title,
        content: sentContent,
        contentText: "",
        _noteId: current.id,
        _saveGeneration: 2,
      });
      await flushAsync();
    });

    expect(fixture.acknowledgeSave).toHaveBeenCalledWith(expect.objectContaining({
      noteId: current.id,
      content: serverContent,
      saveGeneration: 2,
      preserveLocalEditor: true,
    }));
  });
});
