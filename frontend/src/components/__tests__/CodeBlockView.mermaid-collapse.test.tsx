import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { setCodeBlockCollapseMode } from "@/lib/codeBlockPresentation";

vi.mock("@tiptap/react", () => ({
  NodeViewWrapper: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  NodeViewContent: (props: React.HTMLAttributes<HTMLElement>) => <code {...props} />,
}));

vi.mock("@/components/MermaidView", () => ({
  default: ({ source }: { source: string }) => <div data-testid="mermaid-diagram">{source}</div>,
}));

import { CodeBlockView } from "@/components/CodeBlockView";

class FakeEditor {
  isEditable = true;
  isDestroyed = false;
  private listeners = new Map<string, Set<() => void>>();

  on(event: string, listener: () => void) {
    const listeners = this.listeners.get(event) || new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: () => void) {
    this.listeners.get(event)?.delete(listener);
  }
}

function createProps(editor: FakeEditor, updateAttributes = vi.fn(), language = "mermaid") {
  return {
    node: {
      attrs: { language, blockId: "mermaid-fold-test" },
      textContent: language === "mermaid" ? "graph TD; A-->B" : "const answer = 42;",
    },
    editor,
    extension: { options: { lowlight: { listLanguages: () => ["javascript"] } } },
    updateAttributes,
    getPos: () => 1,
  } as unknown as React.ComponentProps<typeof CodeBlockView>;
}

describe("Mermaid code block folding", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];
  const containers: HTMLDivElement[] = [];

  async function mount(editor = new FakeEditor(), updateAttributes = vi.fn()) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<CodeBlockView {...createProps(editor, updateAttributes)} />);
    });
    return { container, editor, updateAttributes };
  }

  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setCodeBlockCollapseMode("expanded");
  });

  afterEach(async () => {
    await act(async () => roots.splice(0).forEach((root) => root.unmount()));
    containers.splice(0).forEach((container) => container.remove());
    setCodeBlockCollapseMode("long");
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("restores the collapse control for Mermaid source and keeps the source DOM mounted", async () => {
    const { container } = await mount();
    const preview = container.querySelector<HTMLElement>(".mermaid-preview-host");
    expect(preview).not.toBeNull();

    await act(async () => {
      preview?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(container.querySelector("[data-testid='mermaid-diagram']")).toBeNull();

    const collapseButton = container.querySelector<HTMLButtonElement>('button[title="折叠代码"]');
    expect(collapseButton).not.toBeNull();
    await act(async () => {
      collapseButton?.click();
    });
    expect(container.querySelector<HTMLElement>("pre.code-block-pre")?.style.maxHeight).toBe("120px");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="展开代码"]')?.click();
    });
    expect(container.querySelector<HTMLElement>("pre.code-block-pre")?.style.maxHeight).toBe("");
  });

  it("folds inline Mermaid previews without rendering the SVG and restores them on expand", async () => {
    const { container, updateAttributes } = await mount();
    const wrapper = container.querySelector<HTMLElement>(".code-block-wrapper");
    expect(wrapper?.dataset.nowenMermaidInlinePreview).toBe("true");
    expect(container.querySelector("[data-testid='mermaid-diagram']")).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.mermaid-preview-collapse-button[title="折叠代码"]')?.click();
    });
    expect(container.querySelector("[data-testid='mermaid-diagram']")).toBeNull();
    expect(container.querySelector(".code-block-pre .code-block-content")).not.toBeNull();
    expect(wrapper?.dataset.nowenMermaidInlinePreview).toBe("true");
    expect(container.querySelector(".mermaid-preview-host")?.textContent).toContain("Mermaid");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.mermaid-preview-collapse-button[title="展开代码"]')?.click();
    });
    expect(container.querySelector("[data-testid='mermaid-diagram']")).not.toBeNull();
    expect(updateAttributes).not.toHaveBeenCalled();
  });

  it("honors default collapsed preference and keeps folding available in read-only mode", async () => {
    setCodeBlockCollapseMode("collapsed");
    const editor = new FakeEditor();
    editor.isEditable = false;
    const { container, updateAttributes } = await mount(editor);

    expect(container.querySelector("[data-testid='mermaid-diagram']")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('.mermaid-preview-collapse-button[title="展开代码"]')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.mermaid-preview-collapse-button[title="展开代码"]')?.click();
    });
    expect(container.querySelector("[data-testid='mermaid-diagram']")).not.toBeNull();
    expect(updateAttributes).not.toHaveBeenCalled();
  });
});
