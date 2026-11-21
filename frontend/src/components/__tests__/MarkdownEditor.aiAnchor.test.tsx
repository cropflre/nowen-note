// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "@/types";

const mocks = vi.hoisted(() => ({ aiChat: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  i18n: { language: "zh-CN", on() {}, off() {} },
}) }));
vi.mock("@/lib/api", () => ({
  api: { aiChat: mocks.aiChat, aiPrompts: { list: async () => ({ items: [] }) } },
  getServerUrl: () => "", getCurrentWorkspace: () => null,
}));
vi.mock("@/lib/aiConnection", () => ({ useAIConnectionAvailable: () => true }));
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const content = "Intro line\n\nHello world\n\nOutro line";
const note: Note = {
  id: "ai-note", userId: "owner", notebookId: "book", workspaceId: null,
  title: "AI", content, contentText: content, contentFormat: "markdown",
  isPinned: 0, isFavorite: 0, isLocked: 0, isArchived: 0, isTrashed: 0,
  trashedAt: null, version: 1, sortOrder: 0, createdAt: "", updatedAt: "",
};

describe("Markdown editor AI assistant writes only where it was opened", () => {
  let host: HTMLDivElement;
  let root: Root;
  let view: EditorView;

  const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const button = (match: (element: HTMLButtonElement) => boolean) => [...document.body.querySelectorAll("button")].find(match);
  const byText = (label: string) => button((element) => element.textContent?.trim() === label);
  const index = (value: string) => view.state.doc.toString().indexOf(value);
  const panel = () => document.body.querySelector('[role="dialog"][aria-label="ai.assistant"]');
  const click = async (element: Element | undefined) => { expect(element).toBeDefined(); await act(async () => (element as HTMLElement).click()); await flush(); };

  async function openAssistantOn(value: string) {
    view.focus();
    await act(async () => view.dispatch({ selection: { anchor: index(value), head: index(value) + value.length } }));
    await click(button((element) => element.getAttribute("title") === "agent.quickRewrite"));
    expect(panel()).not.toBeNull();
    mocks.aiChat.mockImplementation(async (_action: string, _selected: string, _prompt: string, onChunk: (chunk: string) => void) => { onChunk("planet"); });
    await click(byText("ai.actionPolish"));
    expect(byText("ai.replace")).toBeDefined();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    Object.defineProperties(Range.prototype, {
      // The selection toolbar only opens when both ends of the selection have coordinates.
      getClientRects: { configurable: true, value: () => [{ left: 10, right: 60, top: 10, bottom: 26, width: 50, height: 16 }] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect(10, 10, 50, 16) },
    });
    // CodeMirror measures its selection layer with it; jsdom has no hit testing.
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<MarkdownEditor note={note} onUpdate={() => {}} />));
    view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("replaces the selected text even after the caret moved elsewhere", async () => {
    await openAssistantOn("world");
    await act(async () => view.dispatch({ selection: { anchor: index("Outro") } }));
    await click(byText("ai.replace"));
    const text = view.state.doc.toString();
    // The result carries the AI provenance marker, so only the order and the untouched text are asserted.
    expect(text).toMatch(/^Intro line\n\nHello .*planet.*\n\nOutro line$/s);
    expect(text).not.toContain("world");
    expect(panel()).toBeNull();
  });

  it("refuses to replace changed text, writes nothing, and keeps the panel open for copying", async () => {
    await openAssistantOn("world");
    await act(async () => view.dispatch({ changes: { from: index("rld"), insert: "X" } }));
    const before = view.state.doc.toString();
    await click(byText("ai.replace"));
    expect(view.state.doc.toString()).toBe(before);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("ai.applyConflict");
    expect(panel()).not.toBeNull();
    expect(byText("ai.copy")).toBeDefined();
  });

  it("inserts after the original selection instead of the current caret", async () => {
    await openAssistantOn("Hello");
    await act(async () => view.dispatch({ selection: { anchor: index("Outro") } }));
    await click(byText("ai.insertAfter"));
    const text = view.state.doc.toString();
    expect(text).toMatch(/^Intro line\n\nHello.*planet.* world\n\nOutro line$/s);
    expect(panel()).toBeNull();
  });
});
