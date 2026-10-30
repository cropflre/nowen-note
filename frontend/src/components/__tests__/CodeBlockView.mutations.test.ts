import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeViewRendererProps } from "@tiptap/core";
import type { ViewMutationRecord } from "@tiptap/pm/view";
import { createCodeBlockNodeView } from "../CodeBlockView";

const mocks = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("@tiptap/react", () => ({
  NodeViewWrapper: () => null,
  NodeViewContent: () => null,
  ReactNodeViewRenderer: () => mocks.render,
}));

describe("code block React DOM mutation boundary", () => {
  let dom: HTMLDivElement, wrapper: HTMLDivElement, host: HTMLElement, content: HTMLDivElement;
  let original: ReturnType<typeof vi.fn<[], boolean>>;
  let ignore: (mutation: ViewMutationRecord) => boolean;

  beforeEach(() => {
    dom = document.createElement("div");
    wrapper = document.createElement("div");
    wrapper.setAttribute("data-node-view-wrapper", "");
    host = document.createElement("code");
    content = document.createElement("div");
    content.setAttribute("data-node-view-content-react", "");
    dom.append(wrapper);
    wrapper.append(host);
    host.append(content);
    original = vi.fn(() => false);
    mocks.render.mockReturnValue({ dom, contentDOM: content, ignoreMutation: original });
    ignore = createCodeBlockNodeView()({} as NodeViewRendererProps).ignoreMutation!;
  });

  function childList(target: Node, addedNodes: Node[] = [], removedNodes: Node[] = []): ViewMutationRecord {
    return { type: "childList", target, addedNodes, removedNodes } as unknown as ViewMutationRecord;
  }

  it("ignores mounting the React wrapper and moving the managed content container", () => {
    expect(ignore(childList(dom, [wrapper]))).toBe(true);
    expect(ignore(childList(dom, [], [content]))).toBe(true);
    expect(ignore(childList(host, [content]))).toBe(true);
    expect(original).not.toHaveBeenCalled();
  });

  it("preserves native typing, composition, deletion and selection handling", () => {
    const text = document.createTextNode("输入法 text");
    content.append(text);
    const changes = [
      childList(content, [text]), childList(content, [], [text]),
      { type: "characterData", target: text } as unknown as ViewMutationRecord,
      { type: "selection", target: content } as ViewMutationRecord,
      { type: "attributes", target: content } as unknown as ViewMutationRecord,
    ];
    for (const mutation of changes) expect(ignore(mutation)).toBe(false);
    expect(original).toHaveBeenCalledTimes(changes.length);
  });

  it("does not hide unmanaged edits or a genuinely detached content container", () => {
    expect(ignore(childList(host, [document.createElement("div")]))).toBe(false);
    content.remove();
    expect(ignore(childList(host, [], [content]))).toBe(false);
    expect(original).toHaveBeenCalledTimes(2);
  });
});
