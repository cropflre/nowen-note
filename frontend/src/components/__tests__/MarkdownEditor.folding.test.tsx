// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree, foldCode, foldedRanges, unfoldAll } from "@codemirror/language";
import { findNext, openSearchPanel, SearchQuery, setSearchQuery } from "@codemirror/search";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "@/types";

vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  i18n: { language: "zh-CN", on() {}, off() {} },
}) }));
vi.mock("@/lib/api", () => ({ api: {}, getServerUrl: () => "", getCurrentWorkspace: () => null }));
vi.mock("@/hooks/useUserPreferences", () => ({ useUserPreferences: () => ({ prefs: { markdownDefaultViewMode: "source" } }) }));
vi.mock("@/hooks/useKeyboardVisible", () => ({ useKeyboardVisible: () => ({ visible: false }) }));
vi.mock("@/components/MarkdownPreview", () => ({ MarkdownPreview: () => null }));
vi.mock("@/components/AttachmentLibraryPicker", () => ({ default: () => null }));
vi.mock("@/components/TagInput", () => ({ default: () => null }));
vi.mock("@/components/NoteLinkExtension", () => ({ NoteLinkMenu: () => null }));
vi.mock("@/lib/markdownAnalysisClient", () => ({
  createMarkdownAnalysisController: () => ({ analyze: () => 1, destroy() {} }),
}));
import MarkdownEditor from "../MarkdownEditorImpl";
import LargeMarkdownSafeEditor from "../LargeMarkdownSafeEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const content = "# Guide\nintro\n\n## First\nfirst body\n\n### Nested\nhidden target\n\n## Second\nsecond body\n\n# Next\nlast body";
const note: Note = {
  id: "fold-note", userId: "owner", notebookId: "book", workspaceId: null,
  title: "Guide", content, contentText: content, contentFormat: "markdown",
  isPinned: 0, isFavorite: 0, isLocked: 0, isArchived: 0, isTrashed: 0,
  trashedAt: null, version: 1, sortOrder: 0, createdAt: "", updatedAt: "",
};

describe.each([
  ["Markdown editor", MarkdownEditor],
  ["large Markdown editor with syntax support", LargeMarkdownSafeEditor],
] as const)("%s folding", (_name, Component) => {
  let host: HTMLDivElement;
  let root: Root;
  let view: EditorView;
  let navigate: (position: number) => void;
  const onUpdate = vi.fn();

  beforeEach(async () => {
    onUpdate.mockClear();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<Component
      note={note} onUpdate={onUpdate} isGuest
      onEditorReady={(scrollTo) => { navigate = scrollTo; }}
    />));
    view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
    ensureSyntaxTree(view.state, content.length, 1000);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function foldFirst() {
    await act(async () => {
      view.dispatch({ selection: { anchor: content.indexOf("## First") } });
      expect(foldCode(view)).toBe(true);
    });
  }

  it("exposes a gutter and folds children up to the next peer without changing or saving Markdown", async () => {
    expect(host.querySelector(".cm-foldGutter")).not.toBeNull();
    await foldFirst();
    const ranges: Array<[number, number]> = [];
    foldedRanges(view.state).between(0, content.length, (from, to) => { ranges.push([from, to]); });
    expect(ranges).toEqual([[content.indexOf("## First") + "## First".length, content.indexOf("\n\n## Second")]]);
    expect(host.querySelector(".cm-foldPlaceholder")?.getAttribute("title")).toBe("展开");
    expect(view.state.doc.toString()).toBe(content);
    expect(onUpdate).not.toHaveBeenCalled();
    await act(async () => { unfoldAll(view); });
    expect(foldedRanges(view.state).size).toBe(0);
    expect(view.state.doc.toString()).toBe(content);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("reveals a folded search result", async () => {
    await foldFirst();
    await act(async () => {
      openSearchPanel(view);
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "hidden target" })) });
      expect(findNext(view)).toBe(true);
    });
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("hidden target");
    expect(foldedRanges(view.state).size).toBe(0);
  });

  it("reveals a folded heading when navigating from the outline", async () => {
    await foldFirst();
    await act(async () => navigate(content.indexOf("### Nested")));
    expect(view.state.selection.main.head).toBe(content.indexOf("### Nested"));
    expect(foldedRanges(view.state).size).toBe(0);
  });

  it("maps folded ranges when text is inserted before the section", async () => {
    await foldFirst();
    await act(async () => view.dispatch({ changes: { from: 0, insert: "preface\n\n" } }));
    expect(foldedRanges(view.state).size).toBe(1);
    const ranges: number[] = [];
    foldedRanges(view.state).between(0, view.state.doc.length, (from) => { ranges.push(from); });
    expect(ranges).toEqual(["preface\n\n".length + content.indexOf("## First") + "## First".length]);
  });

  it("starts another note expanded even when its Markdown is identical", async () => {
    await foldFirst();
    await act(async () => root.render(<Component note={{ ...note, id: "another-note" }} onUpdate={onUpdate} isGuest />));
    expect(foldedRanges(view.state).size).toBe(0);
    expect(view.state.doc.toString()).toBe(content);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("allows folding in a read-only source view without saving", async () => {
    await act(async () => root.render(<Component note={note} onUpdate={onUpdate} isGuest editable={false} />));
    await foldFirst();
    expect(foldedRanges(view.state).size).toBe(1);
    expect(view.state.doc.toString()).toBe(content);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("keeps code-fence headings inside their enclosing chapter and ignores empty chapters", async () => {
    const source = "# Empty\n# Code\n```md\n# fake\n```\nbody\n# End\nlast";
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source }, selection: { anchor: 0 } });
      ensureSyntaxTree(view.state, source.length, 1000);
      expect(foldCode(view)).toBe(false);
      view.dispatch({ selection: { anchor: source.indexOf("# Code") } });
      expect(foldCode(view)).toBe(true);
    });
    const ranges: Array<[number, number]> = [];
    foldedRanges(view.state).between(0, source.length, (from, to) => { ranges.push([from, to]); });
    expect(ranges).toEqual([[source.indexOf("# Code") + "# Code".length, source.indexOf("\n# End")]]);
  });
});
