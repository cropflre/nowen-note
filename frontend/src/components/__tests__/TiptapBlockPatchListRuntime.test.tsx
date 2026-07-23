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
  getBaseUrl: () => "/api",
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
  Base.displayName = "MockBaseTiptapListRuntime";
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

function item(blockId: string, text: string, nested?: unknown) {
  return {
    type: "listItem",
    attrs: { blockId },
    content: [
      paragraph(`blk_p_${blockId.slice(4)}`, text),
      ...(nested ? [nested] : []),
    ],
  };
}

function list(content: unknown[]) {
  return { type: "bulletList", content };
}

function doc(content: unknown[]) {
  return JSON.stringify({ type: "doc", content });
}

function note(id: string, content: string) {
  return {
    id,
    title: "List note",
    content,
    contentText: "A\nB\nC",
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
    content: JSON.stringify({
      type: "doc",
      content: [paragraph("blk_runtime0", "x".repeat(220_000))],
    }),
    contentFormat: "tiptap-json",
  });
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
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

describe("Tiptap list hierarchy Block Patch runtime", () => {
  it("sends one controlled sink operation in optimized mode", async () => {
    const baseContent = doc([list([
      item("blk_item_a0", "A"),
      item("blk_item_b0", "B"),
      item("blk_item_c0", "C"),
    ])]);
    const nextContent = doc([list([
      item("blk_item_a0", "A", list([item("blk_item_b0", "B")])),
      item("blk_item_c0", "C"),
    ])]);
    const current = note("list-runtime-note", baseContent);
    fixture.snapshot = { content: nextContent, contentText: "A\nB\nC" };
    setActiveEditorRuntimeDecision(current.id, optimizedDecision());
    const wholeSave = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      success: true,
      noteId: current.id,
      title: current.title,
      version: 2,
      updatedAt: "2026-07-23T10:00:00.000Z",
      content: nextContent,
      contentText: "A\nB\nC",
      contentFormat: "tiptap-json",
      notebookId: current.notebookId,
      operationCount: 1,
      affectedBlockIds: ["blk_item_b0", "blk_item_a0"],
      deletedBlockIds: [],
      createdBlocks: [],
      blocks: [],
      indexUpdateMode: "full",
      indexUpdateKind: "full",
      indexedBlockIds: [],
      contentChangedByNormalization: false,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await act(async () => {
      root.render(<TiptapEditorRuntime note={current} onUpdate={wholeSave} />);
    });
    await act(async () => {
      fixture.baseProps.onUpdate({
        title: current.title,
        content: nextContent,
        contentText: "A\nB\nC",
        _noteId: current.id,
        _saveGeneration: 1,
      });
      await flushAsync();
    });

    expect(wholeSave).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(request.operations).toEqual([{
      type: "move",
      scope: "listItem",
      blockId: "blk_item_b0",
      targetBlockId: "blk_item_a0",
      position: "inside",
    }]);
    expect(fixture.acknowledgeSave).toHaveBeenCalledWith(expect.objectContaining({
      noteId: current.id,
      version: 2,
      content: nextContent,
    }));
  });
});
