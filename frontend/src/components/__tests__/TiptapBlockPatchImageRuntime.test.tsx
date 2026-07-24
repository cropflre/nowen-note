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
    return ReactModule.createElement("div", { "data-base-tiptap-image": "" });
  });
  Base.displayName = "MockBaseTiptapImageRuntime";
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

const blockId = "blk_image_runtime";
const src = "/api/attachments/11111111-1111-4111-8111-111111111111/content";

function paragraph(imageAttrs: Record<string, unknown>) {
  return {
    type: "paragraph",
    attrs: { blockId, textAlign: null, lineHeight: null },
    content: [
      { type: "text", text: "Before " },
      { type: "image", attrs: imageAttrs },
      { type: "text", text: " after" },
    ],
  };
}

function documentWith(node: unknown): string {
  return JSON.stringify({ type: "doc", content: [node] });
}

function note(id: string, content: string) {
  return {
    id,
    title: "Image note",
    content,
    contentText: "Before  after",
    contentFormat: "tiptap-json",
    version: 1,
    updatedAt: "2026-07-24T09:00:00.000Z",
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
      content: [{
        type: "paragraph",
        attrs: { blockId: "blk_runtime_seed" },
        content: [{ type: "text", text: "x".repeat(220_000) }],
      }],
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

describe("Tiptap inline image Block Patch runtime", () => {
  it("sends safe image presentation changes as one replace operation", async () => {
    const baseNode = paragraph({
      src,
      alt: "Diagram",
      title: null,
      width: 320,
      height: 180,
      rotation: 0,
      flipX: false,
    });
    const nextNode = paragraph({
      src,
      alt: "Diagram",
      title: "Rotated diagram",
      width: 640,
      height: 360,
      rotation: 90,
      flipX: true,
    });
    const current = note("runtime-image-safe", documentWith(baseNode));
    const nextContent = documentWith(nextNode);
    fixture.snapshot = { content: nextContent, contentText: "Before  after" };
    setActiveEditorRuntimeDecision(current.id, optimizedDecision());
    const wholeSave = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      success: true,
      noteId: current.id,
      title: current.title,
      version: 2,
      updatedAt: "2026-07-24T10:00:00.000Z",
      content: nextContent,
      contentText: "Before  after",
      contentFormat: "tiptap-json",
      notebookId: current.notebookId,
      operationCount: 1,
      affectedBlockIds: [blockId],
      deletedBlockIds: [],
      createdBlocks: [],
      blocks: [],
      indexUpdateMode: "incremental",
      indexUpdateKind: "leaf",
      indexedBlockIds: [blockId],
      contentChangedByNormalization: false,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await act(async () => {
      root.render(<TiptapEditorRuntime note={current} onUpdate={wholeSave} />);
    });
    await act(async () => {
      fixture.baseProps.onUpdate({
        title: current.title,
        content: nextContent,
        contentText: "Before  after",
        _noteId: current.id,
        _saveGeneration: 1,
      });
      await flushAsync();
    });

    expect(wholeSave).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(request.operations).toEqual([{
      type: "replace",
      blockId,
      node: nextNode,
    }]);
    expect(fixture.acknowledgeSave).toHaveBeenCalledWith(expect.objectContaining({
      noteId: current.id,
      version: 2,
      content: nextContent,
    }));
  });
});
