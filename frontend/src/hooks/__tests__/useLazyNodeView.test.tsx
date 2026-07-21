// @vitest-environment jsdom

import React from "react";
import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLazyNodeView } from "@/hooks/useLazyNodeView";
import { resolveEditorRuntimeDecision } from "@/lib/editorRuntimePolicy";
import {
  clearActiveEditorRuntimeDecision,
  setActiveEditorRuntimeDecision,
} from "@/lib/editorRuntimeStore";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function richText(length: number): string {
  return `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${"x".repeat(length)}"}]}]}`;
}

function Harness({ forceMount = false }: { forceMount?: boolean }) {
  const { observeRef, shouldRenderHeavyContent } = useLazyNodeView<HTMLDivElement>({ forceMount });
  return (
    <div ref={observeRef}>
      <span data-testid="state">{shouldRenderHeavyContent ? "mounted" : "deferred"}</span>
    </div>
  );
}

describe("useLazyNodeView", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let intersectionCallback: IntersectionObserverCallback | null = null;

  beforeEach(() => {
    clearActiveEditorRuntimeDecision();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    class MockIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
      root = null;
      rootMargin = "900px 0px";
      thresholds = [0];
    }
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("defers a heavy node until it approaches the viewport", () => {
    const decision = resolveEditorRuntimeDecision({
      content: richText(120_000),
      contentFormat: "tiptap-json",
    });
    setActiveEditorRuntimeDecision("note-lazy", decision);

    act(() => root.render(<Harness />));
    expect(container.querySelector("[data-testid=state]")?.textContent).toBe("deferred");

    act(() => {
      intersectionCallback?.([
        { isIntersecting: true } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
    });
    expect(container.querySelector("[data-testid=state]")?.textContent).toBe("mounted");
  });

  it("mounts immediately when the node is selected or otherwise forced", () => {
    const decision = resolveEditorRuntimeDecision({
      content: richText(400_000),
      contentFormat: "tiptap-json",
    });
    setActiveEditorRuntimeDecision("note-force", decision);

    act(() => root.render(<Harness forceMount />));
    expect(container.querySelector("[data-testid=state]")?.textContent).toBe("mounted");
  });
});
