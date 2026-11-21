import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import type { Note } from "@/types";

const mocks = vi.hoisted(() => ({ aiChat: vi.fn(), editor: null as Editor | null }));
vi.mock("@tiptap/react", async () => {
  const actual = await vi.importActual<typeof import("@tiptap/react")>("@tiptap/react");
  return { ...actual, useEditor: (...args: Parameters<typeof actual.useEditor>) => {
    const editor = actual.useEditor(...args);
    mocks.editor = editor;
    return editor;
  } };
});
vi.mock("@/lib/api", () => ({
  api: { aiChat: mocks.aiChat, aiPrompts: { list: async () => ({ items: [] }) } },
  getServerUrl: () => "", getCurrentWorkspace: () => null, resolveAttachmentUrl: (url: string) => url,
}));
vi.mock("@/lib/aiConnection", () => ({ useAIConnectionAvailable: () => true }));
vi.mock("@/hooks/useUserPreferences", () => ({ useUserPreferences: () => ({ prefs: {} }) }));
vi.mock("@/hooks/useKeyboardVisible", () => ({ useKeyboardVisible: () => ({ visible: false }) }));
vi.mock("../ResizableImageView", () => ({ createResizableImageNodeView: () => () => ({ dom: document.createElement("img") }) }));
vi.mock("@/components/TagInput", () => ({ default: () => null }));
import TiptapEditor from "../TiptapEditor";
import i18n from "@/i18n";

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const note = {
  id: "ai-note", userId: "owner", notebookId: "book", workspaceId: null, title: "AI",
  content: JSON.stringify({ type: "doc", content: [paragraph("Intro line"), paragraph("Hello world"), paragraph("Outro line")] }),
  contentText: "Intro line Hello world Outro line", contentFormat: "tiptap-json", version: 1, tags: [],
} as unknown as Note;

describe("Tiptap editor AI assistant writes only where it was opened", () => {
  let host: HTMLDivElement;
  let root: Root;

  const editor = () => mocks.editor!;
  const flush = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const button = (match: (element: HTMLButtonElement) => boolean) => [...document.body.querySelectorAll("button")].find(match);
  const byText = (label: string) => button((element) => element.textContent?.trim() === label);
  const docText = () => editor().state.doc.textBetween(0, editor().state.doc.content.size, "\n");
  const find = (value: string) => {
    let found = -1;
    editor().state.doc.descendants((node, pos) => { if (found < 0 && node.isText && node.text!.includes(value)) found = pos + node.text!.indexOf(value); });
    if (found < 0) throw new Error(`missing ${value}`);
    return found;
  };
  const panel = () => document.body.querySelector(`[role="dialog"][aria-label="${i18n.t("ai.assistant")}"]`);
  const click = async (element: Element | undefined) => { expect(element).toBeDefined(); await act(async () => (element as HTMLElement).click()); await flush(); };

  async function openAssistantOn(value: string) {
    // jsdom does not focus contenteditable; the selection toolbar only opens for a focused editor.
    vi.spyOn(editor().view, "hasFocus").mockReturnValue(true);
    await act(async () => { editor().commands.setTextSelection({ from: find(value), to: find(value) + value.length }); });
    await flush();
    await click(button((element) => element.getAttribute("title") === i18n.t("agent.quickRewrite")));
    expect(panel()).not.toBeNull();
    mocks.aiChat.mockImplementation(async (_action: string, _selected: string, _prompt: string, onChunk: (chunk: string) => void) => { onChunk("planet"); });
    await click(byText(i18n.t("ai.actionPolish")));
    expect(byText(i18n.t("ai.replace"))).toBeDefined();
  }

  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    Object.defineProperties(Range.prototype, {
      // The selection toolbar only opens when the selection has coordinates.
      getClientRects: { configurable: true, value: () => [{ left: 10, right: 60, top: 10, bottom: 26, width: 50, height: 16 }] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect(10, 10, 50, 16) },
    });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
    await i18n.changeLanguage("zh-CN");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<TiptapEditor note={note} onUpdate={() => {}} />));
    await flush();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("replaces the selected text even after the caret moved elsewhere", async () => {
    await openAssistantOn("world");
    await act(async () => { editor().commands.setTextSelection(find("Outro") + 2); });
    await click(byText(i18n.t("ai.replace")));
    const text = docText();
    expect(text).toMatch(/^Intro line\nHello .*planet.*\nOutro line$/s);
    expect(text).not.toContain("world");
    await vi.waitFor(() => expect(panel()).toBeNull());
  });

  it("refuses to replace changed text, writes nothing, and keeps the panel open for copying", async () => {
    await openAssistantOn("world");
    await act(async () => { editor().commands.insertContentAt(find("rld"), "X"); });
    const before = docText();
    await click(byText(i18n.t("ai.replace")));
    expect(docText()).toBe(before);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(i18n.t("ai.applyConflict"));
    expect(panel()).not.toBeNull();
    expect(byText(i18n.t("ai.copy"))).toBeDefined();
  });

  it("inserts after the original selection instead of the current caret", async () => {
    await openAssistantOn("Hello");
    await act(async () => { editor().commands.setTextSelection(find("Outro") + 2); });
    await click(byText(i18n.t("ai.insertAfter")));
    const text = docText();
    expect(text).toMatch(/^Intro line\nHello.*planet.* world\nOutro line$/s);
    await vi.waitFor(() => expect(panel()).toBeNull());
  });
});
