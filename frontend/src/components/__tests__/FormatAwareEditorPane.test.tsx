import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FormatAwareEditorPane from "../FormatAwareEditorPane";
import {
  EDITOR_MODE_CHANGE_EVENT,
  EDITOR_MODE_KEY,
  resolveEditorMode,
} from "@/lib/editorMode";
import { resolveNoteEditorKind } from "@/lib/noteEditorRouting";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  state: {
    activeNote: null as null | { id: string; contentFormat?: string },
  },
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: mocks.state }),
}));

vi.mock("@/components/EditorPane", () => ({
  default: () => <div data-testid="editor-pane" />,
}));

describe("FormatAwareEditorPane", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    mocks.state.activeNote = null;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/");
  });

  async function render() {
    await act(async () => {
      root.render(<FormatAwareEditorPane />);
    });
  }

  it("Markdown note overrides an incompatible URL mode without mutating global preference", async () => {
    localStorage.setItem(EDITOR_MODE_KEY, "tiptap");
    window.history.replaceState(null, "", "/?md=0");
    mocks.state.activeNote = { id: "md-note", contentFormat: "markdown" };

    await render();

    expect(resolveEditorMode()).toBe("md");
    expect(localStorage.getItem(EDITOR_MODE_KEY)).toBe("tiptap");
    expect(document.querySelector('[data-testid="editor-pane"]')).not.toBeNull();
  });

  it("Tiptap note overrides ?md=1 and remains on the rich-text path", async () => {
    window.history.replaceState(null, "", "/?md=1");
    mocks.state.activeNote = { id: "rich-note", contentFormat: "tiptap-json" };

    await render();

    expect(resolveEditorMode()).toBe("tiptap");
  });

  it("routes HTML through the explicit preview kind", () => {
    expect(resolveNoteEditorKind("html")).toBe("html-preview");
  });

  it("switches note-scoped mode without broadcasting a global preference change", async () => {
    const onPreferenceChange = vi.fn();
    window.addEventListener(EDITOR_MODE_CHANGE_EVENT, onPreferenceChange);
    mocks.state.activeNote = { id: "md-note", contentFormat: "markdown" };
    await render();
    expect(resolveEditorMode()).toBe("md");

    mocks.state.activeNote = { id: "rich-note", contentFormat: "tiptap-json" };
    await render();

    expect(resolveEditorMode()).toBe("tiptap");
    expect(onPreferenceChange).not.toHaveBeenCalled();
    window.removeEventListener(EDITOR_MODE_CHANGE_EVENT, onPreferenceChange);
  });
});
