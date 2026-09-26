// @vitest-environment jsdom

import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeNote: {
    id: "current",
    title: "ABCDEFGH当前",
    notebookId: "nb-1",
    isLocked: false,
    isTrashed: false,
  },
  notesRefreshToken: 0,
  getNotes: vi.fn(),
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: { activeNote: mocks.activeNote, notesRefreshToken: mocks.notesRefreshToken } }),
}));

vi.mock("@/lib/api", () => ({
  api: { getNotes: mocks.getNotes },
}));

vi.mock("@/lib/notePermissions", () => ({
  canWriteNote: () => true,
}));

import TitleDuplicateAssistBridge from "@/components/TitleDuplicateAssistBridge";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ variant = "rich" }: { variant?: "rich" | "markdown" | "large" }) {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef}>
      <TitleDuplicateAssistBridge rootRef={rootRef} />
      {variant === "large" ? (
        <div data-large-markdown-source=""><input className="text-2xl font-bold text-tx-primary" defaultValue="ABCDEFGH当前" /></div>
      ) : (
        <div {...(variant === "rich" ? { "data-mobile-editor-title": "" } : { "data-markdown-mobile-title": "" })}>
          <textarea defaultValue="ABCDEFGH当前" />
        </div>
      )}
    </div>
  );
}

describe("TitleDuplicateAssistBridge", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.notesRefreshToken = 0;
    mocks.getNotes.mockResolvedValue([{
      id: "other",
      title: "ABCDEFGH历史",
      notebookId: "nb-1",
      isTrashed: 0,
    }]);
    vi.stubGlobal("ResizeObserver", class ResizeObserver {
      observe() {}
      disconnect() {}
      unobserve() {}
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.querySelectorAll("[data-title-duplicate-mirror]").forEach((node) => node.remove());
    mocks.getNotes.mockReset();
    vi.unstubAllGlobals();
  });

  it("回车清理提示后，在仍聚焦的标题上再次点击会重建重复提示会话", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => Promise.resolve());

    const field = host.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => field.focus());
    expect(document.querySelector("[data-title-duplicate-mirror]")).not.toBeNull();

    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(document.activeElement).toBe(field);
    expect(document.querySelector("[data-title-duplicate-mirror]")).toBeNull();

    await act(async () => {
      field.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(document.querySelector("[data-title-duplicate-mirror]")).not.toBeNull();
  });

  it("renders separate repeated serial ranges from a descendant notebook", async () => {
    const title = "项目 CM-7023 与 ABC_123456";
    mocks.getNotes.mockResolvedValueOnce([{
      id: "child", title: "历史 cm_7023 和 abc-123456", notebookId: "child-nb", isTrashed: 0,
    }]);
    await act(async () => root.render(<Harness />));
    await act(async () => Promise.resolve());
    const field = host.querySelector<HTMLTextAreaElement>("textarea")!;
    field.value = title;
    await act(async () => field.focus());
    const mirror = document.querySelector<HTMLElement>("[data-title-duplicate-mirror]")!;
    expect(mocks.getNotes).toHaveBeenCalledWith({ notebookId: "nb-1", includeDescendants: "1" });
    expect(mirror.textContent).toBe(title);
    expect(Array.from(mirror.querySelectorAll("span.text-red-500")).map((span) => span.textContent)).toEqual(["CM-7023", "ABC_123456"]);
  });

  it("keeps refreshed descendant candidates when an older request resolves later", async () => {
    let resolveStale!: (notes: Array<{ id: string; title: string; notebookId: string; isTrashed: number }>) => void;
    const stale = new Promise<Array<{ id: string; title: string; notebookId: string; isTrashed: number }>>((resolve) => { resolveStale = resolve; });
    mocks.getNotes.mockReset()
      .mockReturnValueOnce(stale)
      .mockResolvedValueOnce([{ id: "child", title: "ABCDEFGH历史", notebookId: "child-nb", isTrashed: 0 }]);
    await act(async () => root.render(<Harness />));
    const field = host.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => field.focus());
    mocks.notesRefreshToken = 1;
    await act(async () => root.render(<Harness />));
    expect(document.querySelector("[data-title-duplicate-mirror]")?.textContent).toBe("ABCDEFGH当前");

    await act(async () => resolveStale([{ id: "stale", title: "不相干标题", notebookId: "nb-1", isTrashed: 0 }]));
    expect(document.querySelector("[data-title-duplicate-mirror]")?.textContent).toBe("ABCDEFGH当前");
  });

  it.each(["rich", "markdown", "large"] as const)("keeps title entry behavior for %s", async (variant) => {
    await act(async () => root.render(<Harness variant={variant} />));
    await act(async () => Promise.resolve());
    const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")!;
    await act(async () => field.focus());
    expect(document.querySelector("[data-title-duplicate-mirror]")?.textContent).toBe(field.value);
    await act(async () => field.blur());
    expect(document.querySelector("[data-title-duplicate-mirror]")).toBeNull();
  });

  it("hides the mirror during IME composition and restores it afterwards", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => Promise.resolve());
    const field = host.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => field.focus());
    await act(async () => field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    expect(document.querySelector("[data-title-duplicate-mirror]")).toBeNull();
    await act(async () => field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    expect(document.querySelector("[data-title-duplicate-mirror]")?.textContent).toBe(field.value);
  });
});
