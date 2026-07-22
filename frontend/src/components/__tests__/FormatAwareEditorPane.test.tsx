import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FormatAwareEditorPane from "../FormatAwareEditorPane";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  state: {
    activeNote: null as null | { id: string; contentFormat?: string },
  },
  persistEditorMode: vi.fn(),
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: mocks.state }),
}));

vi.mock("@/lib/editorMode", () => ({
  persistEditorMode: mocks.persistEditorMode,
}));

vi.mock("@/components/EditorPane", () => ({
  default: () => <div data-testid="editor-pane" />,
}));

describe("FormatAwareEditorPane", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.activeNote = null;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  async function render() {
    await act(async () => {
      root.render(<FormatAwareEditorPane />);
    });
  }

  it("Markdown 笔记在挂载主编辑器前准备 MD 模式", async () => {
    mocks.state.activeNote = { id: "md-note", contentFormat: "markdown" };

    await render();

    expect(mocks.persistEditorMode).toHaveBeenCalledWith("md");
    expect(document.querySelector('[data-testid="editor-pane"]')).not.toBeNull();
  });

  it("富文本笔记准备 Tiptap 模式", async () => {
    mocks.state.activeNote = { id: "rich-note", contentFormat: "tiptap-json" };

    await render();

    expect(mocks.persistEditorMode).toHaveBeenCalledWith("tiptap");
    expect(document.querySelector('[data-testid="editor-pane"]')).not.toBeNull();
  });

  it("切换不同格式的笔记时重新准备编辑器模式", async () => {
    mocks.state.activeNote = { id: "md-note", contentFormat: "markdown" };
    await render();

    mocks.state.activeNote = { id: "rich-note", contentFormat: "tiptap-json" };
    await render();

    expect(mocks.persistEditorMode).toHaveBeenNthCalledWith(1, "md");
    expect(mocks.persistEditorMode).toHaveBeenLastCalledWith("tiptap");
  });
});
