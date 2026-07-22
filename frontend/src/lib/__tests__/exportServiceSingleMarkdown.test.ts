import { afterEach, describe, expect, it, vi } from "vitest";

const { saveAs, exportSingleNoteCore } = vi.hoisted(() => ({
  saveAs: vi.fn(),
  exportSingleNoteCore: vi.fn(),
}));

vi.mock("file-saver", () => ({ saveAs }));
vi.mock("@/lib/exportServiceCore", () => ({
  exportSingleNote: exportSingleNoteCore,
}));

import { exportSingleNote } from "@/lib/exportService";
import { api } from "@/lib/api";

afterEach(() => {
  vi.restoreAllMocks();
  saveAs.mockReset();
  exportSingleNoteCore.mockReset();
});

describe("single-note native Markdown export", () => {
  it("preserves headings, lists and formulas without folding newlines", async () => {
    const markdown = [
      "### 基础代数与几何",
      "",
      "- 勾股定理：$a^2 + b^2 = c^2$",
      "- 等差数列求和：$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$",
      "",
      "### 微积分",
      "",
      "$$",
      "\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}",
      "$$",
    ].join("\n");
    vi.spyOn(api, "getNote").mockResolvedValue({
      id: "note-md",
      title: "公式笔记",
      content: markdown,
      contentText: markdown,
      contentFormat: "markdown",
      createdAt: "2026-07-13 08:18:37",
      updatedAt: "2026-07-13 08:24:57",
    } as Awaited<ReturnType<typeof api.getNote>>);

    await expect(exportSingleNote("note-md")).resolves.toBe(true);

    expect(saveAs).toHaveBeenCalledTimes(1);
    const exported = await (saveAs.mock.calls[0][0] as Blob).text();
    expect(exported.endsWith(markdown)).toBe(true);
    expect(exported).toContain("---\n### 基础代数与几何");
    expect(exported).not.toContain("\\### 基础代数与几何");
    expect(exportSingleNoteCore).not.toHaveBeenCalled();
  });

  it("passes the untouched multiline source to the attachment ZIP job", async () => {
    const markdown = [
      "正文",
      "",
      "![图片](/api/attachments/att-1)",
      "",
      "### 下一节",
    ].join("\n");
    vi.spyOn(api, "getNote").mockResolvedValue({
      id: "note-md-asset",
      title: "附件笔记",
      content: markdown,
      contentText: markdown,
      contentFormat: "markdown",
      createdAt: "2026-07-13 08:18:37",
      updatedAt: "2026-07-13 08:24:57",
    } as Awaited<ReturnType<typeof api.getNote>>);
    const createJob = vi.spyOn(api, "createMarkdownExportJob").mockResolvedValue({
      job: {
        id: "job-md",
        state: "ready",
        current: 1,
        total: 1,
        message: "导出完成",
        filename: "附件笔记.zip",
        downloadToken: "token-md",
        warnings: 0,
      },
    });
    const download = vi.spyOn(api, "downloadMarkdownExport").mockImplementation(() => {});

    await expect(exportSingleNote("note-md-asset")).resolves.toBe(true);

    expect(createJob).toHaveBeenCalledWith(
      [expect.objectContaining({ markdown, contentFormat: "markdown" })],
      expect.objectContaining({ inlineImages: false, layout: "flat" }),
    );
    expect(download).toHaveBeenCalledWith("token-md", "附件笔记.zip");
    expect(saveAs).not.toHaveBeenCalled();
  });

  it("keeps the existing rich-text conversion path", async () => {
    vi.spyOn(api, "getNote").mockResolvedValue({
      id: "note-rich",
      title: "富文本",
      content: '{"type":"doc","content":[]}',
      contentText: "",
      contentFormat: "tiptap-json",
      createdAt: "2026-07-13 08:18:37",
      updatedAt: "2026-07-13 08:24:57",
    } as Awaited<ReturnType<typeof api.getNote>>);
    exportSingleNoteCore.mockResolvedValue(true);

    await expect(exportSingleNote("note-rich")).resolves.toBe(true);
    expect(exportSingleNoteCore).toHaveBeenCalledWith("note-rich", undefined);
  });
});
