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
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
}));

vi.mock("@/store/AppContext", () => ({
  useAppActions: () => fixture.actions,
}));

vi.mock("@/lib/draftStorage", () => ({
  saveDraft: fixture.saveDraft,
  clearDraft: fixture.clearDraft,
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
  Base.displayName = "MockBaseTiptapEditor";
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

function content(text: string) {
  return JSON.stringify({ type: "doc", content: [paragraph("blk_alpha00", text)] });
}

function note(id: string, text: string, version = 1) {
  return {
    id,
    title: `Note ${id}`,
    content: content(text),
    contentText: text,
    contentFormat: "tiptap-json",
    version,
    updatedAt: "2026-07-22T09:00:00.000Z",
    notebookId: "notebook-1",
    workspaceId: null,
    isLocked: false,
    isTrashed: false,
    isPinned: false,
    isFavorite: false,
  } as any;
}

function optimizedDecision(text: string) {
  return resolveEditorRuntimeDecision({
    content: JSON.stringify({
      type: "doc",
      content: [paragraph("blk_alpha00", text.repeat(220_000))],
    }),
    contentFormat: "tiptap-json",
  });
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function patchResponse(current: any, nextContent: string, version = 2) {
  return new Response(JSON.stringify({
    success: true,
    noteId: current.id,
    title: current.title,
    version,
    updatedAt: "2026-07-22T10:00:00.000Z",
    content: nextContent,
    contentText: "After",
    contentFormat: "tiptap-json",
    notebookId: current.notebookId,
    operationCount: 1,
    affectedBlockIds: ["blk_alpha00"],
    deletedBlockIds: [],
    createdBlocks: [],
    blocks: [],
    contentChangedByNormalization: false,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  localStorage.clear();
  vi.restoreAllMocks();
  Object.values(fixture.actions).forEach((mock) => mock.mockClear());
  fixture.acknowledgeSave.mockClear();
  fixture.saveDraft.mockClear();
  fixture.clearDraft.mockClear();
  fixture.baseProps = null;
  fixture.snapshot = null;
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

describe("Tiptap Block Patch runtime shell", () => {
  it("uses a confirmed patch for a safe optimized-mode text update", async () => {
    const current = note("note-1", "Before");
    const nextContent = content("After");
    fixture.snapshot = { content: nextContent, contentText: "After" };
    setActiveEditorRuntimeDecision(current.id, optimizedDecision("x"));
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
        contentText: "After",
        _noteId: current.id,
        _saveGeneration: 1,
      });
      await flushAsync();
    });

    expect(wholeSave).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      expectedNoteVersion: 1,
      operations: [{ type: "update", blockId: "blk_alpha00", text: "After" }],
    });
    expect(fixture.acknowledgeSave).toHaveBeenCalledWith(expect.objectContaining({
      noteId: current.id,
      version: 2,
      content: nextContent,
    }));
    expect(fixture.actions.setActiveNote).toHaveBeenCalledWith(expect.objectContaining({
      id: current.id,
      version: 2,
      content: nextContent,
    }));
  });

  it("keeps normal-mode edits on the established whole-document save path", async () => {
    const current = note("normal-note", "Before");
    const nextContent = content("After");
    const wholeSave = vi.fn();
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await act(async () => {
      root.render(<TiptapEditorRuntime note={current} onUpdate={wholeSave} />);
    });
    const payload = {
      title: current.title,
      content: nextContent,
      contentText: "After",
      _noteId: current.id,
      _saveGeneration: 1,
    };
    await act(async () => {
      fixture.baseProps.onUpdate(payload);
      await flushAsync();
    });

    expect(wholeSave).toHaveBeenCalledWith(payload);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for the patch version before forwarding a queued title save", async () => {
    const current = note("title-note", "Before");
    const nextContent = content("After");
    fixture.snapshot = { content: nextContent, contentText: "After" };
    setActiveEditorRuntimeDecision(current.id, optimizedDecision("x"));
    const wholeSave = vi.fn();
    let resolveFetch!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));

    await act(async () => {
      root.render(<TiptapEditorRuntime note={current} onUpdate={wholeSave} />);
    });
    await act(async () => {
      fixture.baseProps.onUpdate({
        title: current.title,
        content: nextContent,
        contentText: "After",
        _noteId: current.id,
        _saveGeneration: 1,
      });
      fixture.baseProps.onUpdate({
        title: "Renamed",
        _noteId: current.id,
      });
      await Promise.resolve();
    });
    expect(wholeSave).not.toHaveBeenCalled();

    resolveFetch(patchResponse(current, nextContent));
    await act(async () => flushAsync());
    const confirmed = {
      ...current,
      content: nextContent,
      contentText: "After",
      version: 2,
      updatedAt: "2026-07-22T10:00:00.000Z",
    };
    await act(async () => {
      root.render(<TiptapEditorRuntime note={confirmed} onUpdate={wholeSave} />);
      await flushAsync();
    });

    expect(wholeSave).toHaveBeenCalledTimes(1);
    expect(wholeSave).toHaveBeenCalledWith({
      title: "Renamed",
      _noteId: current.id,
    });
  });

  it("ignores an old patch response after switching to another note", async () => {
    const first = note("note-old", "Before");
    const second = note("note-new", "New");
    const nextContent = content("After");
    fixture.snapshot = { content: nextContent, contentText: "After" };
    setActiveEditorRuntimeDecision(first.id, optimizedDecision("x"));
    let resolveFetch!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));

    await act(async () => {
      root.render(<TiptapEditorRuntime note={first} onUpdate={vi.fn()} />);
    });
    await act(async () => {
      fixture.baseProps.onUpdate({
        title: first.title,
        content: nextContent,
        contentText: "After",
        _noteId: first.id,
        _saveGeneration: 1,
      });
      await Promise.resolve();
    });

    setActiveEditorRuntimeDecision(second.id, optimizedDecision("y"));
    await act(async () => {
      root.render(<TiptapEditorRuntime note={second} onUpdate={vi.fn()} />);
    });
    fixture.actions.setActiveNote.mockClear();

    resolveFetch(patchResponse(first, nextContent));
    await act(async () => flushAsync());

    expect(fixture.actions.setActiveNote).not.toHaveBeenCalled();
    expect(fixture.acknowledgeSave).not.toHaveBeenCalled();
  });
});
