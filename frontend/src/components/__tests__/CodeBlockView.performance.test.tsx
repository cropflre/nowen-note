import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhaseAPerfEvent } from "@/lib/phaseAPerfDiagnostics";
import { publishEditorEditable } from "@/lib/editorEditableStore";

vi.mock("@tiptap/react", () => ({
  NodeViewWrapper: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  NodeViewContent: (props: React.HTMLAttributes<HTMLElement>) => <code {...props} />,
}));

vi.mock("@/components/MermaidView", () => ({
  default: () => <div data-testid="mermaid" />,
}));

import { CodeBlockView } from "@/components/CodeBlockView";

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

  emit(event: string) {
    for (const listener of this.listeners.get(event) || []) listener();
  }
}

describe("CodeBlockView Phase A performance baseline", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];
  const containers: HTMLDivElement[] = [];
  let events: PhaseAPerfEvent[] = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    events = [];
    globalThis.__NOWEN_PHASE_A_PERF_SINK__ = (event) => events.push(event);
  });

  afterEach(async () => {
    await act(async () => roots.splice(0).forEach((root) => root.unmount()));
    containers.splice(0).forEach((container) => container.remove());
    delete globalThis.__NOWEN_PHASE_A_PERF_SINK__;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("does not update untouched code-block permissions for a document transaction", async () => {
    const editor = new FakeEditor();
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <>
          {Array.from({ length: 20 }, (_, index) => (
            <CodeBlockView
              key={index}
              {...({
                node: {
                  attrs: { language: "javascript", blockId: `block-${index}` },
                  textContent: `const value${index} = ${index};`,
                },
                editor,
                extension: { options: { lowlight: { listLanguages: () => ["javascript"] } } },
                updateAttributes: vi.fn(),
                getPos: () => index,
              } as unknown as React.ComponentProps<typeof CodeBlockView>)}
            />
          ))}
        </>,
      );
    });

    events = [];
    await act(async () => {
      editor.emit("transaction");
      editor.emit("update");
    });

    const permissionUpdates = events.filter((event) => event.type === "code-block-permission-state-update");
    const renders = events.filter((event) => event.type === "code-block-render");
    const untouchedRenders = new Set(renders.map((event) => event.blockId).filter((id) => id !== "block-0"));
    console.info("PHASE_A_CODEBLOCK_RESULT", JSON.stringify({
      blocks: 20,
      permissionStateUpdates: permissionUpdates.length,
      renders: renders.length,
      untouchedBlockRenders: untouchedRenders.size,
    }));

    expect(permissionUpdates).toHaveLength(0);
    expect(renders).toHaveLength(0);

    await act(async () => {
      editor.isEditable = false;
      publishEditorEditable(editor);
    });
    expect(events.filter((event) => event.type === "code-block-permission-state-update")).toHaveLength(20);
    expect(container.querySelectorAll("button[disabled]").length).toBe(40);

    events = [];
    await act(async () => {
      editor.isEditable = true;
      publishEditorEditable(editor);
    });
    expect(events.filter((event) => event.type === "code-block-permission-state-update")).toHaveLength(20);
    expect(container.querySelectorAll("button[disabled]").length).toBe(0);
  });
});
