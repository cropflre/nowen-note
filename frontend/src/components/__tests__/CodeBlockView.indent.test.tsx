import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const copyTextMock = vi.hoisted(() => vi.fn());

vi.mock("@tiptap/react", () => ({
  NodeViewWrapper: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  NodeViewContent: (props: React.HTMLAttributes<HTMLElement>) => <code {...props} />,
}));

vi.mock("@/components/MermaidView", () => ({
  default: () => <div data-testid="mermaid" />,
}));

vi.mock("@/lib/clipboard", () => ({
  copyText: copyTextMock,
}));

import { CodeBlockView, normalizeCodeBlockIndent } from "@/components/CodeBlockView";

class FakeEditor {
  isEditable = true;
  isDestroyed = false;
  private listeners = new Map<string, Set<() => void>>();

  on(event: string, listener: () => void) {
    const listeners = this.listeners.get(event) || new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: () => void) {
    this.listeners.get(event)?.delete(listener);
  }
}

function createProps(editor: FakeEditor, indent: unknown, language = "javascript") {
  return {
    node: {
      attrs: { language, blockId: "indent-block", indent },
      textContent: language === "mermaid" ? "graph TD; A-->B" : "const answer = 42;",
    },
    editor,
    extension: { options: { lowlight: { listLanguages: () => ["javascript"] } } },
    updateAttributes: vi.fn(),
    getPos: () => 1,
  } as unknown as React.ComponentProps<typeof CodeBlockView>;
}

describe("CodeBlockView block indent", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];
  const containers: HTMLDivElement[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    copyTextMock.mockReset();
    copyTextMock.mockResolvedValue(true);
  });

  afterEach(async () => {
    await act(async () => roots.splice(0).forEach((root) => root.unmount()));
    containers.splice(0).forEach((container) => container.remove());
    vi.restoreAllMocks();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("normalizes persisted indent values to the supported 0..8 range", () => {
    expect(normalizeCodeBlockIndent(undefined)).toBe(0);
    expect(normalizeCodeBlockIndent(-2)).toBe(0);
    expect(normalizeCodeBlockIndent(3.9)).toBe(3);
    expect(normalizeCodeBlockIndent("8")).toBe(8);
    expect(normalizeCodeBlockIndent(99)).toBe(8);
  });

  it("maps indent onto the NodeView root and reacts to node attribute updates", async () => {
    const editor = new FakeEditor();
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(<CodeBlockView {...createProps(editor, 3)} />);
    });
    expect(container.querySelector(".code-block-wrapper")?.getAttribute("data-indent")).toBe("3");

    await act(async () => {
      root.render(<CodeBlockView {...createProps(editor, 99, "mermaid")} />);
    });
    expect(container.querySelector(".code-block-wrapper")?.getAttribute("data-indent")).toBe("8");
    expect(container.querySelector("[data-testid='mermaid']")).not.toBeNull();

    await act(async () => {
      root.render(<CodeBlockView {...createProps(editor, 0)} />);
    });
    expect(container.querySelector(".code-block-wrapper")?.hasAttribute("data-indent")).toBe(false);
  });

  it("uses the shared clipboard fallback and reports success after a real copy", async () => {
    const editor = new FakeEditor();
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(<CodeBlockView {...createProps(editor, 0)} />);
    });

    const copyButton = container.querySelector<HTMLButtonElement>('button[title="复制代码"]');
    expect(copyButton).not.toBeNull();

    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(copyTextMock).toHaveBeenCalledWith("const answer = 42;");
    expect(container.querySelector<HTMLButtonElement>('button[title="已复制"]')).not.toBeNull();
  });

  it("does not show copied state when every clipboard path fails", async () => {
    copyTextMock.mockResolvedValueOnce(false);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const editor = new FakeEditor();
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(<CodeBlockView {...createProps(editor, 0)} />);
    });

    const copyButton = container.querySelector<HTMLButtonElement>('button[title="复制代码"]');
    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLButtonElement>('button[title="已复制"]')).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith("Copy code block failed: clipboard API unavailable");
  });
});
