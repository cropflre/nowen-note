import React from "react";
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import WordDocumentEditor from "@/components/WordDocumentEditor";
import type { Note } from "@/types";

function makeWordNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "word-note-1",
    userId: "u1",
    notebookId: "nb1",
    workspaceId: null,
    title: "无障碍测试文档",
    content: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "wordPageSetup",
          attrs: {
            paperSize: "A4",
            orientation: "portrait",
            marginTop: 72,
            marginRight: 72,
            marginBottom: 72,
            marginLeft: 72,
            headerText: "顶部页眉",
            footerText: "底部页脚",
          },
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "你好 Word" }],
        },
      ],
    }),
    contentText: "你好 Word",
    contentFormat: "tiptap-json",
    noteType: "word",
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isArchived: 0,
    isTrashed: 0,
    trashedAt: null,
    version: 1,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("WordDocumentEditor 渲染与无障碍体验", () => {
  it("渲染工具栏、页眉页脚、状态播报区，并支持页面设置与无障碍增强模式切换", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onUpdate = vi.fn();

    await act(async () => {
      root.render(
        <WordDocumentEditor
          note={makeWordNote()}
          onUpdate={onUpdate}
          editable={true}
        />,
      );
    });

    // 无障碍结构：工具栏、状态播报区、跳过链接、页眉页脚
    expect(container.querySelector('[role="toolbar"][aria-label="Word 文档编辑工具栏"]')).not.toBeNull();
    expect(container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
    expect(container.querySelector(".nowen-word-skip-link")?.textContent).toContain("跳到文档正文编辑区");
    expect(container.textContent).toContain("顶部页眉");
    expect(container.textContent).toContain("底部页脚");

    // 点击“页面设置”展开页面设置面板
    const pageSetupBtn = container.querySelector('button[aria-label="页面设置"]') as HTMLButtonElement;
    expect(pageSetupBtn).not.toBeNull();
    await act(async () => {
      pageSetupBtn.click();
    });
    expect(container.querySelector('section[aria-label="页面设置面板"]')).not.toBeNull();

    // 切换“无障碍增强”高对比大字模式
    const contrastBtn = container.querySelector('button[aria-label="无障碍高对比大字模式"]') as HTMLButtonElement;
    expect(contrastBtn).not.toBeNull();
    await act(async () => {
      contrastBtn.click();
    });
    const shell = container.querySelector('[data-word-editor="true"]');
    expect(shell?.getAttribute("data-high-contrast")).toBe("true");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
