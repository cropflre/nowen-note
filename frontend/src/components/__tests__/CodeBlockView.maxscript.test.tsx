import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodeBlockLowlight } from "@/lib/codeBlockLowlight";

vi.mock("@tiptap/react", () => ({
  NodeViewWrapper: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  NodeViewContent: (props: React.HTMLAttributes<HTMLElement>) => <code {...props} />,
}));

vi.mock("@/components/MermaidView", () => ({
  default: () => <div data-testid="mermaid" />,
}));

import { CodeBlockView } from "@/components/CodeBlockView";

describe("CodeBlockView MAXScript language picker", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];
  const containers: HTMLDivElement[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => roots.splice(0).forEach((root) => root.unmount()));
    containers.splice(0).forEach((container) => container.remove());
    document.querySelectorAll("[data-codeblock-langpicker]").forEach((element) => {
      if (!element.closest(".code-block-wrapper")) element.remove();
    });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("shows one canonical MAXScript option and product label", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <CodeBlockView
          {...({
            node: {
              attrs: { language: "maxscript", blockId: "maxscript-block" },
              textContent: "fn build = matrix3 1",
            },
            editor: { isEditable: true, isDestroyed: false },
            extension: { options: { lowlight: createCodeBlockLowlight() } },
            updateAttributes: vi.fn(),
            getPos: () => 0,
          } as unknown as React.ComponentProps<typeof CodeBlockView>)}
        />,
      );
    });

    const languageButton = container.querySelector<HTMLButtonElement>('button[title="切换语言"]');
    expect(languageButton?.textContent).toContain("MAXScript");

    await act(async () => {
      languageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const picker = document.body.querySelector<HTMLElement>(
      '[data-codeblock-langpicker][style*="position: fixed"]',
    );
    const labels = Array.from(picker?.querySelectorAll("button") || []).map((button) => button.textContent?.trim());

    expect(labels.filter((label) => label === "MAXScript")).toHaveLength(1);
    expect(labels).not.toContain("ms");
    expect(labels).not.toContain("mcr");
  });
});
