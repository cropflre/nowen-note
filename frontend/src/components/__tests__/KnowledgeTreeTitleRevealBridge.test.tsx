import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import KnowledgeTreeTitleRevealBridge from "../KnowledgeTreeTitleRevealBridge";

const mocks = vi.hoisted(() => ({
  reveal: vi.fn(),
  state: { activeNote: { id: "note-1", isTrashed: false } },
}));
vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: mocks.state }) }));
vi.mock("@/lib/knowledgeTreeCreateVisibility", () => ({ revealKnowledgeTreeNote: mocks.reveal }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, options: { defaultValue: string }) => options.defaultValue }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("editor title tree location", () => {
  let host: HTMLDivElement;
  let root: Root;
  const rootRef = createRef<HTMLDivElement>();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.activeNote = { id: "note-1", isTrashed: false };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function render(content: React.ReactNode) {
    await act(async () => root.render(<div ref={rootRef}>
      <KnowledgeTreeTitleRevealBridge rootRef={rootRef} />
      {content}
    </div>));
  }

  it.each(["data-mobile-editor-title", "data-markdown-mobile-title"])("reveals the current note from %s without cancelling title selection", async (attribute) => {
    await render(<><div {...{ [attribute]: "" }}><textarea defaultValue="Document title" /></div><textarea data-body="" /></>);
    const field = host.querySelector("textarea")!;
    field.focus();
    field.setSelectionRange(0, 8);
    expect(field.title).toBe("双击在目录中定位");
    const event = new MouseEvent("dblclick", { bubbles: true, cancelable: true });
    await act(async () => field.dispatchEvent(event));
    expect(mocks.reveal).toHaveBeenCalledWith("note-1");
    expect(event.defaultPrevented).toBe(false);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(8);
    expect(document.activeElement).toBe(field);
    await act(async () => host.querySelector("[data-body]")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(mocks.reveal).toHaveBeenCalledTimes(1);
  });

  it("waits for the lazy safe editor and follows active note changes", async () => {
    await render(null);
    await act(async () => {
      rootRef.current!.insertAdjacentHTML("beforeend", '<div data-large-markdown-source=""></div><input class="text-2xl font-bold text-tx-primary" title="标题" />');
    });
    const field = host.querySelector("input")!;
    expect(field.title).toBe("标题\n双击在目录中定位");
    mocks.state.activeNote = { id: "note-2", isTrashed: false };
    await render(null);
    await act(async () => field.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(mocks.reveal).toHaveBeenCalledWith("note-2");
    mocks.state.activeNote = { id: "note-2", isTrashed: true };
    await render(null);
    expect(field.title).toBe("标题");
    await act(async () => field.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(mocks.reveal).toHaveBeenCalledTimes(1);
  });
});
