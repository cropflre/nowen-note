// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LargeRichTextSafeViewer from "../LargeRichTextSafeViewer";
import { prepareLargeRichTextNoteForDisplay } from "@/lib/largeRichTextSafeMode";
import type { NoteEditorHandle, NoteEditorHeading } from "@/components/editors/types";
import type { Note } from "@/types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.defaultValue && typeof opts.defaultValue === "string") return opts.defaultValue;
      if (opts?.value !== undefined) return `${key}:${opts.value}`;
      return key;
    },
    i18n: { language: "zh-CN", resolvedLanguage: "zh-CN" },
  }),
}));

vi.mock("../VirtualRichTextSectionEditor", () => ({
  default: function MockVirtualRichTextSectionEditor(props: {
    section: { id: string; startBlock: number; endBlock: number };
    blocks: unknown[];
    onSave: (sectionDocJson: string) => void;
    onCancel: () => void;
  }) {
    return (
      <div data-mock-section-editor={props.section.id}>
        <button
          type="button"
          data-mock-section-save="true"
          onClick={() =>
            props.onSave(
              JSON.stringify({
                type: "doc",
                content: [
                  {
                    type: "heading",
                    attrs: { level: 1, blockId: "h-top" },
                    content: [{ type: "text", text: "总览章节（已局部修订）" }],
                  },
                ],
              }),
            )
          }
        >
          save
        </button>
        <button type="button" data-mock-section-cancel="true" onClick={props.onCancel}>
          cancel
        </button>
      </div>
    );
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function createBaseNote(overrides: Partial<Note>): Note {
  return {
    id: "note-large-1",
    notebookId: "nb-1",
    title: "超长富文本压测笔记",
    content: "",
    contentText: "",
    contentFormat: "tiptap-json",
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isTrashed: 0,
    isArchived: 0,
    version: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tags: [],
    ...overrides,
  };
}

function buildLargeRichTextNote(blockCount = 2_000): Note {
  const content: Record<string, unknown>[] = [
    {
      type: "heading",
      attrs: { level: 1, blockId: "h-top" },
      content: [{ type: "text", text: "总览章节" }],
    },
    {
      type: "taskList",
      attrs: { blockId: "tasks-1" },
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [{ type: "paragraph", content: [{ type: "text", text: "验证虚拟勾选写回" }] }],
        },
      ],
    },
  ];
  for (let i = 0; i < blockCount; i++) {
    content.push({
      type: "paragraph",
      attrs: { blockId: `p-${i}` },
      content: [
        { type: "text", text: `第 ${i} 段 ` },
        { type: "text", text: "富文本加粗", marks: [{ type: "bold" }] },
        { type: "text", text: " 内容填充 ".repeat(40) },
      ],
    });
  }
  const raw = JSON.stringify({ type: "doc", content });
  return prepareLargeRichTextNoteForDisplay(
    createBaseNote({
      content: raw,
      contentText: `总览章节\n验证虚拟勾选写回\n${"示例纯文本索引\n".repeat(400)}`,
    }),
  );
}

describe("LargeRichTextSafeViewer (Tier 2 virtual rich text & Tier 3 virtual plain text)", () => {
  it("renders a 2,000+ block rich-text note with bounded DOM nodes, outline headings, and no monolithic textarea", () => {
    const note = buildLargeRichTextNote(2_000);
    const headingsSpy = vi.fn<(headings: NoteEditorHeading[]) => void>();
    const ref = React.createRef<NoteEditorHandle>();

    act(() => {
      root.render(
        <LargeRichTextSafeViewer
          ref={ref}
          note={note}
          onHeadingsChange={headingsSpy}
          editable={true}
        />,
      );
    });

    expect(container.querySelector("[data-virtual-rich-text-viewport='true']")).not.toBeNull();
    expect(container.querySelector("textarea")).toBeNull();

    const renderedBlocks = container.querySelectorAll("[data-virtual-block-index]");
    expect(renderedBlocks.length).toBeGreaterThan(0);
    expect(renderedBlocks.length).toBeLessThan(120);

    // Rich formatting is preserved in the virtual DOM
    expect(container.querySelector("h1")?.textContent).toBe("总览章节");
    expect(container.querySelector("strong")?.textContent).toBe("富文本加粗");

    // Headings are published to the outline sidebar
    expect(headingsSpy).toHaveBeenCalled();
    const published = headingsSpy.mock.calls.at(-1)?.[0] ?? [];
    expect(published[0]).toMatchObject({ id: "h-top", level: 1, text: "总览章节", pos: 0 });

    // Imperative snapshot returns the full untouched tiptap-json
    expect(ref.current?.getSnapshot()?.content).toBe(note.content);
  });

  it("toggles a task checkbox directly in virtual mode and emits valid updated tiptap-json", () => {
    const note = buildLargeRichTextNote(1_500);
    const onUpdate = vi.fn();

    act(() => {
      root.render(
        <LargeRichTextSafeViewer
          note={note}
          onUpdate={onUpdate}
          editable={true}
        />,
      );
    });

    const checkbox = container.querySelector("input[type='checkbox']") as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(false);

    act(() => {
      checkbox!.click();
    });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const payload = onUpdate.mock.calls[0][0];
    expect(payload._noteId).toBe(note.id);
    const savedDoc = JSON.parse(payload.content);
    expect(savedDoc.type).toBe("doc");
    expect(savedDoc.content[1].type).toBe("taskList");
    expect(savedDoc.content[1].content[0].attrs.checked).toBe(true);
    expect(savedDoc.content).toHaveLength(1_502);
  });

  it("opens single-section click-to-edit and splices the saved section back into the full tiptap-json", () => {
    const note = buildLargeRichTextNote(1_400);
    const onUpdate = vi.fn();

    act(() => {
      root.render(
        <LargeRichTextSafeViewer
          note={note}
          onUpdate={onUpdate}
          editable={true}
        />,
      );
    });

    // Double-click the first block to enter section edit mode
    const firstBlock = container.querySelector("[data-virtual-block-index='0']") as HTMLElement | null;
    expect(firstBlock).not.toBeNull();
    act(() => {
      firstBlock!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    const saveBtn = container.querySelector("[data-mock-section-save='true']") as HTMLButtonElement | null;
    expect(saveBtn).not.toBeNull();

    act(() => {
      saveBtn!.click();
    });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const savedDoc = JSON.parse(onUpdate.mock.calls[0][0].content);
    expect(savedDoc.content[0].content[0].text).toBe("总览章节（已局部修订）");
    // Unedited blocks outside the first 120-block section are preserved intact
    expect(savedDoc.content.length).toBe(1_402 - 120 + 1);
    expect(savedDoc.content.at(-1).attrs.blockId).toBe("p-1399");
  });

  it("switches to Tier 3 true virtualized plain-text view on toggle without mounting a textarea", () => {
    const note = buildLargeRichTextNote(1_200);
    act(() => {
      root.render(<LargeRichTextSafeViewer note={note} editable={true} />);
    });

    const plainTabBtn = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("markdown.largeDocument.plainTextViewTab"),
    );
    expect(plainTabBtn).toBeDefined();

    act(() => {
      plainTabBtn!.click();
    });

    expect(container.querySelector("[data-virtual-plain-text-viewport='true']")).not.toBeNull();
    expect(container.querySelector("[data-virtual-rich-text-viewport='true']")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("falls back automatically to Tier 3 virtual plain-text viewer for legacy HTML and preserves original content", () => {
    const originalHtml = `<div>${"<p>超长遗留 HTML 段落内容</p>".repeat(50_000)}</div>`;
    const note = prepareLargeRichTextNoteForDisplay(
      createBaseNote({
        contentFormat: "html",
        content: originalHtml,
        contentText: Array.from({ length: 5_000 }, (_, i) => `纯文本第 ${i} 行`).join("\n"),
      }),
    );
    const ref = React.createRef<NoteEditorHandle>();

    act(() => {
      root.render(<LargeRichTextSafeViewer ref={ref} note={note} editable={true} />);
    });

    expect(container.querySelector("[data-virtual-plain-text-viewport='true']")).not.toBeNull();
    expect(container.querySelector("textarea")).toBeNull();

    const renderedLines = container.querySelectorAll("[data-virtual-plain-line]");
    expect(renderedLines.length).toBeGreaterThan(0);
    expect(renderedLines.length).toBeLessThan(150);

    // Original HTML content is never overwritten by plain text
    expect(ref.current?.getSnapshot()?.content).toBe(originalHtml);
  });
});
