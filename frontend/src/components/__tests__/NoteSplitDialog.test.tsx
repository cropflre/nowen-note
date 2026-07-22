import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import NoteSplitDialog from "../NoteSplitDialog";
import type { Note, Notebook } from "@/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  class MockNoteSplitRequestError extends Error {
    code?: string;
    status?: number;
    currentVersion?: number;
    blockLinkCount?: number;
  }
  return {
    getNote: vi.fn(),
    splitMarkdownNote: vi.fn(),
    undoMarkdownNoteSplit: vi.fn(),
    MockNoteSplitRequestError,
  };
});

vi.mock("@/lib/api", () => ({
  api: { getNote: mocks.getNote },
}));

vi.mock("@/lib/noteSplitApi", () => ({
  NoteSplitRequestError: mocks.MockNoteSplitRequestError,
  splitMarkdownNote: mocks.splitMarkdownNote,
  undoMarkdownNoteSplit: mocks.undoMarkdownNoteSplit,
}));

const note: Note = {
  id: "note-1",
  userId: "user-1",
  notebookId: "book-1",
  workspaceId: null,
  title: "Book",
  content: "# Alpha\na\n# Beta\nb\n# Gamma\ng",
  contentText: "Alpha a Beta b Gamma g",
  contentFormat: "markdown",
  isPinned: 0,
  isFavorite: 0,
  isLocked: 0,
  isArchived: 0,
  isTrashed: 0,
  trashedAt: null,
  version: 7,
  sortOrder: 0,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const richNote: Note = {
  ...note,
  id: "rich-note-1",
  contentFormat: "tiptap-json",
  content: JSON.stringify({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1, blockId: "blk_alpha_h" }, content: [{ type: "text", text: "Alpha" }] },
      { type: "paragraph", attrs: { blockId: "blk_alpha_p" }, content: [{ type: "text", text: "A" }] },
      { type: "heading", attrs: { level: 1, blockId: "blk_beta_h" }, content: [{ type: "text", text: "Beta" }] },
      { type: "paragraph", attrs: { blockId: "blk_beta_p" }, content: [{ type: "text", text: "B" }] },
    ],
  }),
};

const notebooks: Notebook[] = [{
  id: "book-1",
  userId: "user-1",
  workspaceId: null,
  parentId: null,
  name: "Book",
  description: null,
  icon: "📒",
  color: null,
  sortOrder: 0,
  isExpanded: 1,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  permission: "manage",
}];

function splitResult(source: Note, indexes: number[]) {
  return {
    operationId: "op-1",
    sourceNote: { ...source, version: source.version + 1, content: "directory" },
    createdNotes: indexes.map((index) => ({
      ...source,
      id: `child-${index}`,
      title: index === 0 ? "Alpha" : "Gamma",
      version: 1,
    })),
    headingLevel: 1,
    preservePreamble: true,
    selectedSectionIndexes: indexes,
    retainedSectionCount: Math.max(0, 3 - indexes.length),
    totalSectionCount: 3,
    canUndo: true,
  };
}

describe("NoteSplitDialog", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.getNote.mockResolvedValue(note);
    mocks.splitMarkdownNote.mockResolvedValue(splitResult(note, [0, 2]));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  async function renderDialog(activeNote: Note) {
    await act(async () => {
      root.render(
        <NoteSplitDialog
          open
          note={activeNote}
          notebooks={notebooks}
          preferredLevel={1}
          onClose={vi.fn()}
          onApplied={vi.fn()}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
  }

  it("submits only checked Markdown section indexes", async () => {
    await renderDialog(note);

    const alpha = document.querySelector('[data-testid="note-split-section-0"]') as HTMLInputElement;
    const beta = document.querySelector('[data-testid="note-split-section-1"]') as HTMLInputElement;
    const gamma = document.querySelector('[data-testid="note-split-section-2"]') as HTMLInputElement;
    expect(alpha.checked).toBe(true);
    expect(beta.checked).toBe(true);
    expect(gamma.checked).toBe(true);

    await act(async () => {
      beta.click();
    });
    expect(beta.checked).toBe(false);

    const confirm = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("拆分所选 2 篇"));
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(mocks.splitMarkdownNote).toHaveBeenCalledWith("note-1", {
      version: 7,
      headingLevel: 1,
      sectionIndexes: [0, 2],
      targetNotebookId: "book-1",
      preservePreamble: true,
      acknowledgeBlockLinkRisk: false,
    });
  });

  it("requires a second explicit confirmation for Tiptap external block links", async () => {
    mocks.getNote.mockResolvedValue(richNote);
    const warning = new mocks.MockNoteSplitRequestError("block links need confirmation");
    warning.code = "BLOCK_LINKS_REQUIRE_CONFIRMATION";
    warning.blockLinkCount = 2;
    mocks.splitMarkdownNote
      .mockRejectedValueOnce(warning)
      .mockResolvedValueOnce({
        ...splitResult(richNote, [0, 1]),
        retainedSectionCount: 0,
        totalSectionCount: 2,
        blockLinkWarningCount: 2,
      });

    await renderDialog(richNote);
    const firstConfirm = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("拆分所选 2 篇"));
    await act(async () => {
      firstConfirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("检测到 2 个外部 Block 引用");
    expect(mocks.splitMarkdownNote).toHaveBeenNthCalledWith(1, "rich-note-1", expect.objectContaining({
      sectionIndexes: [0, 1],
      acknowledgeBlockLinkRisk: false,
    }));

    const riskConfirm = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("确认风险并继续"));
    expect(riskConfirm).toBeTruthy();
    await act(async () => {
      riskConfirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(mocks.splitMarkdownNote).toHaveBeenNthCalledWith(2, "rich-note-1", expect.objectContaining({
      sectionIndexes: [0, 1],
      acknowledgeBlockLinkRisk: true,
    }));
  });
});
