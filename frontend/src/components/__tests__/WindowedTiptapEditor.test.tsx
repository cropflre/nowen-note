import React, { act, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { NoteEditorHandle } from "@/components/editors/types";
import { splitTiptapSubdocumentSections } from "@/lib/yjsSubdocumentModel";

const apiMocks = vi.hoisted(() => ({
  getManifest: vi.fn(),
  getState: vi.fn(),
  applyUpdate: vi.fn(),
  editorProps: [] as any[],
  outlineScrolls: [] as Array<{ sectionId: string; pos: number }>,
  suppressUpdates: false,
}));

vi.mock("@/lib/api", () => ({
  api: {
    getYjsSubdocumentManifest: apiMocks.getManifest,
    getYjsSubdocumentState: apiMocks.getState,
    applyYjsSubdocumentUpdate: apiMocks.applyUpdate,
  },
}));

vi.mock("../TiptapEditor", () => ({
  default: forwardRef<NoteEditorHandle, any>(function MockSectionEditor(props, ref) {
    const { note, onUpdate } = props;
    const onEditorReady = props.onEditorReady as ((callback: (pos: number) => void) => void) | undefined;
    apiMocks.editorProps.push(props);
    const valueRef = React.useRef(note.content);
    const sectionId = JSON.parse(note.content).content[0]?.attrs?.blockId || "empty";
    React.useEffect(() => {
      onEditorReady?.((pos: number) => apiMocks.outlineScrolls.push({ sectionId, pos }));
    }, [onEditorReady, sectionId]);
    useImperativeHandle(ref, () => ({
      flushSave: () => undefined,
      getSnapshot: () => ({ content: valueRef.current, contentText: "" }),
      isReady: () => true,
    }), []);
    return (
      <textarea
        data-section-editor={sectionId}
        defaultValue={note.content}
        onChange={(event) => {
          valueRef.current = event.target.value;
          if (!apiMocks.suppressUpdates) {
            onUpdate({ content: event.target.value, contentText: "", title: note.title });
          }
        }}
      />
    );
  }),
}));

import WindowedTiptapEditor from "../WindowedTiptapEditor";

function largeNote(id = "window-note") {
  return {
    id,
    userId: "user",
    notebookId: "book",
    workspaceId: null,
    title: "Window",
    content: JSON.stringify({
      type: "doc",
      content: Array.from({ length: 520 }, (_, index) => ({
        type: "paragraph",
        attrs: { blockId: `blk_${String(index).padStart(6, "0")}` },
        content: [{ type: "text", text: `p${index}` }],
      })),
    }),
    contentText: "",
    contentFormat: "tiptap-json",
    version: 1,
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isArchived: 0,
    isTrashed: 0,
    sortOrder: 0,
    createdAt: "2026-01-01 00:00:00",
    updatedAt: "2026-01-01 00:00:00",
    tags: [],
  } as any;
}

function headingNote() {
  const blocks = [
    { type: "heading", attrs: { level: 1, blockId: "blk_heading_a" }, content: [{ type: "text", text: "章节 A" }] },
    { type: "paragraph", attrs: { blockId: "blk_paragraph_a" }, content: [{ type: "text", text: "A content" }] },
    { type: "heading", attrs: { level: 2, blockId: "blk_heading_b" }, content: [{ type: "text", text: "章节 B" }] },
    { type: "paragraph", attrs: { blockId: "blk_paragraph_b" }, content: [{ type: "text", text: "B content" }] },
    { type: "heading", attrs: { level: 3, blockId: "blk_heading_b_detail" }, content: [{ type: "text", text: "章节 B 细节" }] },
    { type: "heading", attrs: { level: 2, blockId: "blk_heading_c" }, content: [{ type: "text", text: "章节 C" }] },
  ];
  return {
    ...largeNote("window-heading-note"),
    content: JSON.stringify({ type: "doc", content: blocks }),
    contentText: "章节 A\nA content\n章节 B\nB content\n章节 B 细节\n章节 C",
  };
}

function encodeState(content: string, guid: string): string {
  const doc = new Y.Doc({ guid });
  doc.getText("content").insert(0, content);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeContentUpdate(content: string, guid: string, replacement: string): string {
  const doc = new Y.Doc({ guid });
  const text = doc.getText("content");
  text.insert(0, content);
  const vector = Y.encodeStateVector(doc);
  doc.transact(() => {
    text.delete(0, text.length);
    text.insert(0, replacement);
  });
  const bytes = Y.encodeStateAsUpdate(doc, vector);
  doc.destroy();
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function changeTextarea(editor: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(editor, value);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function installHealthyApi(note = largeNote()) {
  const sections = splitTiptapSubdocumentSections(note.id, note.content, 250)!;
  apiMocks.getManifest.mockResolvedValue({
    rootGuid: `nowen-root-${note.id}`,
    generation: 1,
    structureVersion: 1,
    sections: sections.map(({ id, guid, startBlock, endBlock }) => ({ id, guid, startBlock, endBlock })),
  });
  apiMocks.getState.mockImplementation(async (_noteId: string, sectionId: string) => {
    const section = sections.find((candidate) => candidate.id === sectionId)!;
    return { guid: section.guid, stateBase64: encodeState(section.content, section.guid) };
  });
  apiMocks.applyUpdate.mockResolvedValue({
    success: true,
    content: note.content,
    contentText: "",
    sectionGuid: sections[0].guid,
    version: 2,
    generation: 1,
    structureVersion: 1,
  });
  return sections;
}

describe("WindowedTiptapEditor", () => {
  let host: HTMLDivElement;
  let root: Root;
  let callbacks: IntersectionObserverCallback[];

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    callbacks = [];
    class MockIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
      takeRecords = vi.fn(() => []);
      root = null;
      rootMargin = "1200px 0px";
      thresholds = [0];
    }
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    apiMocks.getManifest.mockReset();
    apiMocks.getState.mockReset();
    apiMocks.applyUpdate.mockReset();
    apiMocks.editorProps.length = 0;
    apiMocks.outlineScrolls.length = 0;
    apiMocks.suppressUpdates = false;
    installHealthyApi();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps a bounded editor set and restores an offscreen section", async () => {
    await act(async () => root.render(<WindowedTiptapEditor note={largeNote()} onUpdate={vi.fn()} />));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(1));
    expect(host.querySelectorAll("[data-windowed-tiptap-section]")).toHaveLength(3);
    await act(async () => callbacks[1]?.([{ isIntersecting: true, boundingClientRect: { height: 700 } } as any], {} as any));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(2));
    await act(async () => callbacks[1]?.([{ isIntersecting: false, boundingClientRect: { height: 700 } } as any], {} as any));
    expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(1);
    expect(host.querySelectorAll("[data-windowed-tiptap-section]")[1]?.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("delegates every mounted section to the parent scroll container", async () => {
    await act(async () => root.render(<WindowedTiptapEditor note={largeNote()} onUpdate={vi.fn()} />));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(1));
    expect(apiMocks.editorProps.at(-1)?.useParentScrollContainer).toBe(true);

    await act(async () => callbacks[1]?.([{ isIntersecting: true, boundingClientRect: { height: 700 } } as any], {} as any));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(2));
    expect(apiMocks.editorProps.at(-1)?.useParentScrollContainer).toBe(true);
  });

  it("publishes every section heading and routes an outline click to its owning section", async () => {
    const note = headingNote();
    installHealthyApi(note);
    let headings: Array<{ text: string; pos: number }> = [];
    let scrollTo: ((pos: number) => void) | null = null;

    await act(async () => root.render(
      <WindowedTiptapEditor
        note={note}
        onUpdate={vi.fn()}
        onHeadingsChange={(next) => { headings = next; }}
        onEditorReady={(next) => { scrollTo = next; }}
      />,
    ));

    expect(headings).not.toHaveLength(4);
    await vi.waitFor(() => expect(headings.map((heading) => heading.text)).toEqual([
      "章节 A",
      "章节 B",
      "章节 B 细节",
      "章节 C",
    ]));
    expect(scrollTo).not.toBeNull();

    await act(async () => scrollTo?.(headings[1].pos));
    await vi.waitFor(() => expect(apiMocks.outlineScrolls).toContainEqual({
      sectionId: "blk_heading_b",
      pos: 0,
    }));
  });

  it("章节在防抖更新前卸载时用最新快照刷新该章节大纲", async () => {
    const note = headingNote();
    installHealthyApi(note);
    let headings: Array<{ text: string; pos: number }> = [];
    await act(async () => root.render(
      <WindowedTiptapEditor
        note={note}
        onUpdate={vi.fn()}
        onHeadingsChange={(next) => { headings = next; }}
      />,
    ));
    await vi.waitFor(() => expect(headings).toHaveLength(4));
    await act(async () => callbacks[1]?.([{ isIntersecting: true, boundingClientRect: { height: 640 } } as any], {} as any));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(2));

    apiMocks.suppressUpdates = true;
    const secondEditor = host.querySelectorAll<HTMLTextAreaElement>("[data-section-editor]")[1];
    const sectionDoc = JSON.parse(secondEditor.value);
    sectionDoc.content.push({
      type: "heading",
      attrs: { level: 4, blockId: "blk_snapshot_heading" },
      content: [{ type: "text", text: "快照新增标题" }],
    });
    await act(async () => changeTextarea(secondEditor, JSON.stringify(sectionDoc)));
    expect(headings.map((heading) => heading.text)).not.toContain("快照新增标题");

    await act(async () => callbacks[1]?.([{ isIntersecting: false, boundingClientRect: { height: 640 } } as any], {} as any));

    await vi.waitFor(() => expect(headings.map((heading) => heading.text)).toContain("快照新增标题"));
  });

  it("已挂载章节内的深层标题由子编辑器完成最终精确定位", async () => {
    const note = headingNote();
    installHealthyApi(note);
    const frameScroll = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: frameScroll,
    });
    let headings: Array<{ text: string; pos: number }> = [];
    let scrollTo: ((pos: number) => void) | null = null;

    await act(async () => root.render(
      <WindowedTiptapEditor
        note={note}
        onUpdate={vi.fn()}
        onHeadingsChange={(next) => { headings = next; }}
        onEditorReady={(next) => { scrollTo = next; }}
      />,
    ));
    await vi.waitFor(() => expect(headings).toHaveLength(4));
    await act(async () => callbacks[1]?.([{ isIntersecting: true, boundingClientRect: { height: 640 } } as any], {} as any));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(2));
    frameScroll.mockClear();

    await act(async () => scrollTo?.(headings[2].pos));

    const localScroll = apiMocks.outlineScrolls.find((item) => item.sectionId === "blk_heading_b");
    expect(localScroll?.pos).toBeGreaterThan(0);
    expect(frameScroll).not.toHaveBeenCalled();
  });

  it("keeps the shared toolbar sticky against the whole windowed scroll container", async () => {
    await act(async () => root.render(<WindowedTiptapEditor note={largeNote()} onUpdate={vi.fn()} />));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-windowed-tiptap-section]")).toHaveLength(3));
    const windowed = host.querySelector<HTMLElement>("[data-windowed-tiptap-editor]")!;
    const frames = host.querySelectorAll<HTMLElement>("[data-windowed-tiptap-section]");

    expect(windowed.parentElement?.classList.contains("relative")).toBe(true);
    expect(frames[0].style.display).toBe("contents");
    expect(frames[1].style.display).toBe("");
  });

  it("renders one viewport back-to-top control for the shared scroll container", async () => {
    await act(async () => root.render(<WindowedTiptapEditor note={largeNote()} onUpdate={vi.fn()} />));
    await vi.waitFor(() => expect(host.querySelector("[data-windowed-tiptap-editor]")).not.toBeNull());
    const windowed = host.querySelector<HTMLElement>("[data-windowed-tiptap-editor]")!;
    const scrollTo = vi.fn();
    windowed.scrollTo = scrollTo;

    windowed.scrollTop = 300;
    await act(async () => windowed.dispatchEvent(new Event("scroll", { bubbles: true })));
    const buttons = host.querySelectorAll<HTMLButtonElement>("[data-windowed-back-to-top]");
    expect(buttons).toHaveLength(1);

    await act(async () => buttons[0].click());
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });

    windowed.scrollTop = 0;
    await act(async () => windowed.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(host.querySelector("[data-windowed-back-to-top]")).toBeNull();
  });

  it("does not unload a section while IME composition is active", async () => {
    await act(async () => root.render(<WindowedTiptapEditor note={largeNote()} onUpdate={vi.fn()} />));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(1));
    await act(async () => callbacks[1]?.([{ isIntersecting: true, boundingClientRect: { height: 600 } } as any], {} as any));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(2));
    const second = host.querySelectorAll<HTMLElement>("[data-windowed-tiptap-section]")[1];
    await act(async () => second.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await act(async () => callbacks[1]?.([{ isIntersecting: false, boundingClientRect: { height: 600 } } as any], {} as any));
    expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(2);
    await act(async () => second.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await act(async () => callbacks[1]?.([{ isIntersecting: false, boundingClientRect: { height: 600 } } as any], {} as any));
    expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(1);
  });

  it("loads section snapshots only when each section first enters the window", async () => {
    const sections = installHealthyApi();
    await act(async () => root.render(<WindowedTiptapEditor note={largeNote()} onUpdate={vi.fn()} />));

    await vi.waitFor(() => expect(apiMocks.getState).toHaveBeenCalledTimes(1));
    expect(apiMocks.getState).toHaveBeenLastCalledWith("window-note", sections[0].id);
    await act(async () => callbacks[2]?.([{ isIntersecting: true, boundingClientRect: { height: 640 } } as any], {} as any));
    await vi.waitFor(() => expect(apiMocks.getState).toHaveBeenCalledTimes(2));
    expect(apiMocks.getState).toHaveBeenLastCalledWith("window-note", sections[2].id);
  });

  it("falls back when the server manifest does not exactly match local sections", async () => {
    const sections = installHealthyApi();
    apiMocks.getManifest.mockResolvedValue({
      rootGuid: "nowen-root-window-note",
      sections: sections.map((section, index) => ({
        ...section,
        guid: index === 1 ? `${section.guid}-mismatch` : section.guid,
      })),
    });
    const onFallback = vi.fn();

    await act(async () => root.render(
      <WindowedTiptapEditor note={largeNote()} onUpdate={vi.fn()} onFallback={onFallback} />,
    ));

    await vi.waitFor(() => expect(onFallback).toHaveBeenCalledWith(
      "subdocument-manifest-mismatch",
      expect.objectContaining({ content: expect.any(String) }),
    ));
    expect(apiMocks.getState).not.toHaveBeenCalled();
  });

  it("keeps offline edits pending and flushes them on the browser online event", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const onUpdate = vi.fn();
    const onSubdocumentCommit = vi.fn();
    await act(async () => root.render(
      <WindowedTiptapEditor
        note={largeNote()}
        onUpdate={onUpdate}
        onSubdocumentCommit={onSubdocumentCommit}
      />,
    ));
    await vi.waitFor(() => expect(host.querySelector("[data-section-editor]")).not.toBeNull());
    const editor = host.querySelector<HTMLTextAreaElement>("[data-section-editor]")!;
    const changed = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", attrs: { blockId: "blk_000000" }, content: [{ type: "text", text: "offline" }] }],
    });
    await act(async () => {
      changeTextarea(editor, changed);
    });
    expect(apiMocks.applyUpdate).not.toHaveBeenCalled();

    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    await act(async () => window.dispatchEvent(new Event("online")));
    await vi.waitFor(() => expect(apiMocks.applyUpdate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onSubdocumentCommit).toHaveBeenCalledTimes(1));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("falls back immediately with the latest local snapshot after server resegmentation", async () => {
    const resegmentedContent = largeNote().content.replace("p0", "server-resegmented");
    apiMocks.applyUpdate.mockResolvedValue({
      success: true,
      content: resegmentedContent,
      contentText: "server-resegmented",
      sectionGuid: "guid-after-resegment",
      version: 2,
      generation: 2,
      structureVersion: 2,
    });
    const onFallback = vi.fn();
    await act(async () => root.render(
      <WindowedTiptapEditor note={largeNote()} onUpdate={vi.fn()} onFallback={onFallback} />,
    ));
    await vi.waitFor(() => expect(host.querySelector("[data-section-editor]")).not.toBeNull());
    const editor = host.querySelector<HTMLTextAreaElement>("[data-section-editor]")!;

    await act(async () => changeTextarea(editor, editor.value.replace("p0", "local-change")));

    await vi.waitFor(() => expect(onFallback).toHaveBeenCalledWith(
      "subdocument-structure-changed",
      expect.objectContaining({ content: expect.stringContaining("local-change") }),
    ));
    expect(apiMocks.applyUpdate).toHaveBeenCalledWith(
      "window-note",
      expect.any(String),
      expect.any(String),
      1,
    );
  });

  it("preserves a second local edit made while a resegmentation request is in flight", async () => {
    let resolveUpdate!: (value: any) => void;
    apiMocks.applyUpdate.mockReturnValueOnce(new Promise((resolve) => { resolveUpdate = resolve; }));
    const onFallback = vi.fn();
    await act(async () => root.render(
      <WindowedTiptapEditor note={largeNote()} onUpdate={vi.fn()} onFallback={onFallback} />,
    ));
    await vi.waitFor(() => expect(host.querySelector("[data-section-editor]")).not.toBeNull());
    const editor = host.querySelector<HTMLTextAreaElement>("[data-section-editor]")!;

    await act(async () => changeTextarea(editor, editor.value.replace("p0", "first-edit")));
    await vi.waitFor(() => expect(apiMocks.applyUpdate).toHaveBeenCalledTimes(1));
    await act(async () => changeTextarea(editor, editor.value.replace("first-edit", "latest-inflight-edit")));
    await act(async () => resolveUpdate({
      success: true,
      content: largeNote().content.replace("p0", "first-edit"),
      contentText: "first-edit",
      sectionGuid: "guid-after-resegment",
      version: 2,
      generation: 2,
      structureVersion: 2,
    }));

    await vi.waitFor(() => expect(onFallback).toHaveBeenCalledWith(
      "subdocument-structure-changed",
      expect.objectContaining({ content: expect.stringContaining("latest-inflight-edit") }),
    ));
    expect(apiMocks.applyUpdate).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("nowen:yjs-subdocument-pending:window-note")).toContain("\"generation\":1");
  });

  it("uses the committed server snapshot when restored pending resegments before any section mounts", async () => {
    const note = largeNote();
    const sections = splitTiptapSubdocumentSections(note.id, note.content, 250)!;
    const replacement = sections[0].content.replace("p0", "restored-structural-edit");
    localStorage.setItem("nowen:yjs-subdocument-pending:window-note", JSON.stringify({
      version: 2,
      generation: 1,
      sections: {
        [sections[0].id]: encodeContentUpdate(sections[0].content, sections[0].guid, replacement),
      },
    }));
    const committedContent = note.content.replace("p0", "restored-structural-edit");
    apiMocks.applyUpdate.mockResolvedValueOnce({
      success: true,
      content: committedContent,
      contentText: "restored-structural-edit",
      sectionGuid: sections[0].guid,
      version: 2,
      generation: 2,
      structureVersion: 2,
    });
    const onFallback = vi.fn();

    await act(async () => root.render(
      <WindowedTiptapEditor note={note} onUpdate={vi.fn()} onFallback={onFallback} />,
    ));

    await vi.waitFor(() => expect(onFallback).toHaveBeenCalledWith(
      "subdocument-structure-changed",
      { content: committedContent, contentText: "restored-structural-edit" },
    ));
    expect(apiMocks.getState).not.toHaveBeenCalled();
  });

  it("propagates only a real title change through the parent update callback", async () => {
    const onUpdate = vi.fn();
    await act(async () => root.render(<WindowedTiptapEditor note={largeNote()} onUpdate={onUpdate} />));
    await vi.waitFor(() => expect(apiMocks.editorProps).not.toHaveLength(0));
    const first = apiMocks.editorProps[apiMocks.editorProps.length - 1];

    await act(async () => first.onUpdate({
      content: first.note.content,
      contentText: "",
      title: "Renamed",
    }));

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ title: "Renamed", _noteId: "window-note" });
  });

  it("falls back with the latest merged snapshot for a cross-section selection", async () => {
    const onFallback = vi.fn();
    await act(async () => root.render(
      <WindowedTiptapEditor note={largeNote()} onUpdate={vi.fn()} onFallback={onFallback} />,
    ));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(1));
    await act(async () => callbacks[1]?.([{ isIntersecting: true, boundingClientRect: { height: 600 } } as any], {} as any));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(2));
    const editors = host.querySelectorAll<HTMLTextAreaElement>("[data-section-editor]");
    const changed = editors[0].value.replace("p0", "latest-local-value");
    await act(async () => changeTextarea(editors[0], changed));
    const selectionSpy = vi.spyOn(document, "getSelection").mockReturnValue({
      anchorNode: editors[0],
      focusNode: editors[1],
    } as unknown as Selection);

    await act(async () => document.dispatchEvent(new Event("selectionchange")));

    expect(onFallback).toHaveBeenCalledWith(
      "subdocument-cross-section-selection",
      expect.objectContaining({ content: expect.stringContaining("latest-local-value") }),
    );
    selectionSpy.mockRestore();
  });

  it("blocks a cross-section drop and falls back to the monolithic editor", async () => {
    const onFallback = vi.fn();
    await act(async () => root.render(
      <WindowedTiptapEditor note={largeNote()} onUpdate={vi.fn()} onFallback={onFallback} />,
    ));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-windowed-tiptap-section]")).toHaveLength(3));
    const frames = host.querySelectorAll<HTMLElement>("[data-windowed-tiptap-section]");
    await act(async () => frames[0].dispatchEvent(new Event("dragstart", { bubbles: true })));
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    await act(async () => frames[1].dispatchEvent(drop));

    expect(drop.defaultPrevented).toBe(true);
    expect(onFallback).toHaveBeenCalledWith(
      "subdocument-cross-section-drop",
      expect.objectContaining({ content: expect.any(String) }),
    );
  });

  it("searches the latest edited section value after that section is unmounted", async () => {
    await act(async () => root.render(<WindowedTiptapEditor note={largeNote()} onUpdate={vi.fn()} />));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(1));
    await act(async () => callbacks[1]?.([{ isIntersecting: true, boundingClientRect: { height: 600 } } as any], {} as any));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(2));
    const secondEditor = host.querySelectorAll<HTMLTextAreaElement>("[data-section-editor]")[1];
    await act(async () => changeTextarea(secondEditor, secondEditor.value.replace("p250", "latest-search-token")));
    await act(async () => callbacks[1]?.([{ isIntersecting: false, boundingClientRect: { height: 600 } } as any], {} as any));
    expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(1);
    Element.prototype.scrollIntoView = vi.fn();

    await act(async () => root.render(
      <WindowedTiptapEditor note={largeNote()} onUpdate={vi.fn()} searchQuery="latest-search-token" />,
    ));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-section-editor]")).toHaveLength(2));
  });

  it("destroys the previous note controller so its pending update cannot flush after switching", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    await act(async () => root.render(<WindowedTiptapEditor note={largeNote()} onUpdate={vi.fn()} />));
    await vi.waitFor(() => expect(host.querySelector("[data-section-editor]")).not.toBeNull());
    const editor = host.querySelector<HTMLTextAreaElement>("[data-section-editor]")!;
    await act(async () => {
      changeTextarea(editor, editor.value.replace("p0", "pending-old-note"));
    });
    expect(apiMocks.applyUpdate).not.toHaveBeenCalled();

    const nextNote = largeNote("window-note-next");
    installHealthyApi(nextNote);
    await act(async () => root.render(<WindowedTiptapEditor note={nextNote} onUpdate={vi.fn()} />));
    await vi.waitFor(() => expect(apiMocks.getManifest).toHaveBeenLastCalledWith("window-note-next"));
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    await act(async () => window.dispatchEvent(new Event("online")));
    await Promise.resolve();

    expect(apiMocks.applyUpdate).not.toHaveBeenCalled();
  });
});
