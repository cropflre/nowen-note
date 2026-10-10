// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FolderSyncAttachmentPreviewPane, {
  isFolderSyncAttachmentNote,
} from "@/components/FolderSyncAttachmentPreviewPane";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    files: {
      list: mocks.list,
    },
  },
  resolveAttachmentUrl: (url: string) => `resolved:${url}`,
}));

vi.mock("@/components/attachmentPreview/AttachmentPreview", () => ({
  default: (props: { url: string; filename: string; mimeType: string; size: number }) => (
    <div
      data-testid="attachment-preview"
      data-url={props.url}
      data-filename={props.filename}
      data-mime={props.mimeType}
      data-size={String(props.size)}
    />
  ),
}));

describe("FolderSyncAttachmentPreviewPane", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.list.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("只把带来源标记的同步笔记识别为附件预览笔记", () => {
    expect(isFolderSyncAttachmentNote("正文\n<!-- nowen-folder-sync: sourcePathHash=abc relativePath=%E6%89%AB%E6%8F%8F%E4%BB%B6.pdf -->")).toBe(true);
    expect(isFolderSyncAttachmentNote("正文\n<!-- nowen-folder-sync: sourcePathHash=abc relativePath=docs%2Freport.docx -->")).toBe(true);
    expect(isFolderSyncAttachmentNote("正文\n<!-- nowen-folder-sync: sourcePathHash=abc relativePath=docs%2Freadme.md -->")).toBe(false);
    expect(isFolderSyncAttachmentNote("<!-- nowen-folder-sync-extracted:start -->正文")).toBe(false);
    expect(isFolderSyncAttachmentNote("普通 Markdown 笔记")).toBe(false);
  });

  it("加载笔记绑定的 PDF 并直接交给统一附件预览组件", async () => {
    mocks.list.mockResolvedValue({
      items: [
        { id: "text", filename: "readme.txt", mimeType: "text/plain", size: 10, url: "/api/attachments/text" },
        { id: "other", filename: "其他.pdf", mimeType: "application/pdf", size: 1024, url: "/api/attachments/other" },
        { id: "pdf", filename: "扫描件.pdf", mimeType: "application/pdf", size: 2048, url: "/api/attachments/pdf" },
      ],
      total: 3,
      page: 1,
      pageSize: 200,
    });

    await act(async () => {
      root.render(
        <FolderSyncAttachmentPreviewPane
          noteId="note-1"
          revision={3}
          content={"# 扫描件\n\n- 文件名：扫描件.pdf\n\n<!-- nowen-folder-sync: relativePath=%E6%89%AB%E6%8F%8F%E4%BB%B6.pdf -->"}
          onOpenAttachmentDirectory={() => {}}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.list).toHaveBeenCalledWith({ noteId: "note-1", pageSize: 200, sort: "created_desc" });
    const preview = host.querySelector<HTMLElement>('[data-testid="attachment-preview"]');
    expect(preview?.dataset.url).toBe("resolved:/api/attachments/pdf");
    expect(preview?.dataset.filename).toBe("扫描件.pdf");
    expect(preview?.dataset.mime).toBe("application/pdf");
    expect(preview?.dataset.size).toBe("2048");
  });

  it("附件缺失时给出明确提示并保留附件目录入口", async () => {
    mocks.list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
    const onOpenAttachmentDirectory = vi.fn();

    await act(async () => {
      root.render(
        <FolderSyncAttachmentPreviewPane
          noteId="note-2"
          revision={1}
          content={"# 缺失\n\n- 文件名：缺失.pdf\n\n<!-- nowen-folder-sync: relativePath=%E7%BC%BA%E5%A4%B1.pdf -->"}
          onOpenAttachmentDirectory={onOpenAttachmentDirectory}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain("没有找到可预览的 PDF 或 DOCX 附件");
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("打开附件目录"));
    expect(button).toBeDefined();
    act(() => button?.click());
    expect(onOpenAttachmentDirectory).toHaveBeenCalledOnce();
  });
});
