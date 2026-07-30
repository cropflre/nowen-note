import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NoteAttachmentsPanel from "../NoteAttachmentsPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  copyText: vi.fn(),
  resolveAttachmentUrl: vi.fn((src: string) => `http://127.0.0.1:10001${src}`),
}));

vi.mock("@/lib/api", () => ({
  api: { files: { list: mocks.list } },
  resolveAttachmentUrl: mocks.resolveAttachmentUrl,
}));

vi.mock("@/lib/clipboard", () => ({ copyText: mocks.copyText }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/attachmentDetail/AttachmentDetailDrawer", () => ({ default: () => null }));
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("NoteAttachmentsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    mocks.copyText.mockReset().mockResolvedValue(true);
    mocks.resolveAttachmentUrl.mockClear();
    mocks.list.mockReset().mockResolvedValue({
      items: [{
        id: "attachment-1",
        filename: "新样式链.dotx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
        size: 18 * 1024,
        createdAt: "2026-07-21 00:00:00",
        url: "/api/attachments/attachment-1",
      }],
      total: 1,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<NoteAttachmentsPanel noteId="note-1" noteTitle="word文档" onClose={() => {}} />);
    });
    await vi.waitFor(() => {
      expect(container.querySelector('button[title="复制笔记内链接"]')).not.toBeNull();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("复制可写入笔记的相对附件地址，而不是当前后端的绝对地址", async () => {
    const copyButton = container.querySelector('button[title="复制笔记内链接"]') as HTMLButtonElement;

    await act(async () => {
      copyButton.click();
    });

    expect(mocks.copyText).toHaveBeenCalledWith("/api/attachments/attachment-1");
  });
});
