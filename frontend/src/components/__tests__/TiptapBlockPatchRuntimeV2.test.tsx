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
  Base.displayName = "MockBaseTiptapEditorV2";
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

function paragraph(blockId: string, content: unknown[]) {
  return {
    type: "paragraph",
    attrs: { blockId, textAlign: null, lineHeight: null },
    content,
  };
}

function documentWith(node: unknown) {
  return JSON.stringify({ type: "doc", content: [node] });
}

function note(id: string, content: string, version = 1) {
  return {
    id,
    title: `Note ${id}`,
    content,
    contentText: "Before",
    contentFormat: "tiptap-json",
    version,
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
      content: [paragraph("blk_runtime0", [{ type: "text", text: "x".repeat(220_000) }])],
    }),
    contentFormat: "tiptap-json",
  });
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function patchResponse(current: any, nextContent: string) {
  return new Response(JSON.stringify({
    success: true,
    noteId: current.id,
    title: current.title,
    version: 2,
    updatedAt: "2026-07-23T10:00:00.000Z",
    content: nextContent,
    contentText: "Formatted",
    contentFormat: "tiptap-json",
    notebookId: current.notebookId,
    operationCount: 1,
    affectedBlockIds: ["blk_runtime0"],
    deletedBlockIds: [],
    createdBlocks: [],
    blocks: [],
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

describe("Tiptap Block Patch V2 runtime", () => {
  it("sends a safe formatted block as a replace operation", async () => {
    const blockId = "blk_runtime0";
    const current = note("runtime-v2-safe", documentWith(
      paragraph(blockId, [{ type: "text", text: "Before" }]),
    ));
    const nextNode = paragraph(blockId, [
      { type: "text", text: "Bold", marks: [{ type: "bold" }] },
      {
        type: "text",
        text: " link",
        marks: [{
          type: "link",
          attrs: {
            href: "https://example.com",
            target: "_blank",
            rel: "noopener noreferrer nofollow",
            class: null,
          },
        }],
      },
    ]);
    const nextContent = documentWith(nextNode);
    fixture.snapshot = { content: nextContent, contentText: "Bold link" };
    setActiveEditorRuntimeDecision(current.id, optimizedDecision());
    const wholeSave = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      patchResponse(current, nextContent),
    );

    await act(async () => {
      root.render(<TiptapEditorRuntime note={current} onUpdate={wholeSave} />);
    });
    await act(async () => {
      fixture.baseProps.onUpdate({
        title: current.title,
        content: nextContent,
        contentText: "Bold link",
        _noteId: current.id,
        _saveGeneration: 1,
      });
      await flushAsync();
    });

    expect(wholeSave).not.toHaveBeenCalled();
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

  it("keeps an unsafe link change on the whole-document save path", async () => {
    const blockId = "blk_runtime0";
    const current = note("runtime-v2-unsafe", documentWith(
      paragraph(blockId, [{ type: "text", text: "Before" }]),
    ));
    const nextContent = documentWith(paragraph(blockId, [{
      type: "text",
      text: "Unsafe",
      marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
    }]));
    setActiveEditorRuntimeDecision(current.id, optimizedDecision());
    const wholeSave = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await act(async () => {
      root.render(<TiptapEditorRuntime note={current} onUpdate={wholeSave} />);
    });
    const payload = {
      title: current.title,
      content: nextContent,
      contentText: "Unsafe",
      _noteId: current.id,
      _saveGeneration: 1,
    };
    await act(async () => {
      fixture.baseProps.onUpdate(payload);
      await flushAsync();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(wholeSave).toHaveBeenCalledWith(payload);
  });
});
