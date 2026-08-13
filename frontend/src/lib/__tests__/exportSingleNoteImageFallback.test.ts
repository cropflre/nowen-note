import { afterEach, describe, expect, it, vi } from "vitest";

const { saveAs, exportSingleNoteCore, normalizeToMarkdown } = vi.hoisted(() => ({
  saveAs: vi.fn(),
  exportSingleNoteCore: vi.fn(),
  normalizeToMarkdown: vi.fn(),
}));

vi.mock("file-saver", () => ({ saveAs }));
vi.mock("@/lib/exportServiceCore", () => ({
  exportSingleNote: exportSingleNoteCore,
}));
vi.mock("@/lib/contentFormat", () => ({ normalizeToMarkdown }));

import { exportSingleNote } from "@/lib/exportService";
import { api } from "@/lib/api";

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error || new Error("failed to read Blob"));
    reader.readAsText(blob);
  });
}

function mockImageFetch(status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
    status === 200 ? new Uint8Array([0x89, 0x50, 0x4e, 0x47]) : "missing",
    {
      status,
      headers: { "content-type": status === 200 ? "image/png" : "text/plain" },
    },
  )));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  saveAs.mockReset();
  exportSingleNoteCore.mockReset();
  normalizeToMarkdown.mockReset();
  localStorage.clear();
});

describe("Issue #693 single-note Markdown image export fallback", () => {
  it("falls back to a self-contained .md when a native Markdown image ZIP job fails", async () => {
    const markdown = [
      "# 图片笔记",
      "",
      "![截图](/api/attachments/att-image-1)",
    ].join("\n");
    vi.spyOn(api, "getNote").mockResolvedValue({
      id: "note-md-image",
      title: "图片笔记",
      content: markdown,
      contentText: markdown,
      contentFormat: "markdown",
      createdAt: "2026-08-07 10:00:00",
      updatedAt: "2026-08-07 10:01:00",
    } as Awaited<ReturnType<typeof api.getNote>>);
    vi.spyOn(api, "createMarkdownExportJob").mockRejectedValue(
      new Error("部分笔记不存在或不属于当前导出空间"),
    );
    mockImageFetch();

    await expect(exportSingleNote("note-md-image")).resolves.toBe(true);

    expect(saveAs).toHaveBeenCalledTimes(1);
    expect(saveAs.mock.calls[0][1]).toBe("图片笔记.md");
    const exported = await readBlobText(saveAs.mock.calls[0][0] as Blob);
    expect(exported).toContain("# 图片笔记");
    expect(exported).toContain("![截图](data:image/png;base64,");
    expect(exported).not.toContain("/api/attachments/att-image-1");
  });

  it("also recovers rich-text notes after the core attachment-package path returns false", async () => {
    vi.spyOn(api, "getNote").mockResolvedValue({
      id: "note-rich-image",
      title: "富文本图片",
      content: JSON.stringify({
        type: "doc",
        content: [{ type: "image", attrs: { src: "/api/attachments/att-image-2", alt: "图" } }],
      }),
      contentText: "图",
      contentFormat: "tiptap-json",
      createdAt: "2026-08-07 10:00:00",
      updatedAt: "2026-08-07 10:01:00",
    } as Awaited<ReturnType<typeof api.getNote>>);
    exportSingleNoteCore.mockResolvedValue(false);
    normalizeToMarkdown.mockReturnValue("![图](/api/attachments/att-image-2)");
    mockImageFetch();

    await expect(exportSingleNote("note-rich-image")).resolves.toBe(true);

    expect(exportSingleNoteCore).toHaveBeenCalledWith("note-rich-image", undefined);
    expect(normalizeToMarkdown).toHaveBeenCalledTimes(1);
    expect(saveAs).toHaveBeenCalledTimes(1);
    const exported = await readBlobText(saveAs.mock.calls[0][0] as Blob);
    expect(exported).toContain("![图](data:image/png;base64,");
    expect(exported).not.toContain("/api/attachments/att-image-2");
  });

  it("does not report success when the fallback image itself cannot be downloaded", async () => {
    const markdown = "![截图](/api/attachments/att-missing)";
    vi.spyOn(api, "getNote").mockResolvedValue({
      id: "note-missing-image",
      title: "缺图笔记",
      content: markdown,
      contentText: markdown,
      contentFormat: "markdown",
      createdAt: "2026-08-07 10:00:00",
      updatedAt: "2026-08-07 10:01:00",
    } as Awaited<ReturnType<typeof api.getNote>>);
    vi.spyOn(api, "createMarkdownExportJob").mockRejectedValue(new Error("ZIP failed"));
    mockImageFetch(404);

    await expect(exportSingleNote("note-missing-image")).resolves.toBe(false);
    expect(saveAs).not.toHaveBeenCalled();
  });
});
