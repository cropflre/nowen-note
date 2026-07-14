import { afterEach, describe, expect, it, vi } from "vitest";
const { requestNotePrint } = vi.hoisted(() => ({ requestNotePrint: vi.fn() }));

vi.mock("@/lib/notePrintBridge", () => ({ requestNotePrint }));

import { exportSingleNote, noteContentToExportHtml, printNote } from "@/lib/exportService";
import { api } from "@/lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("noteContentToExportHtml", () => {
  it("renders native Markdown notes to HTML for image export", () => {
    const markdown = [
      "# 一级标题",
      "",
      "正文段落",
      "",
      "## 二级标题",
      "",
      "- 第一条",
      "- 第二条",
      "",
      "> 引用内容",
      "",
      "```js",
      "console.log(\"hello\");",
      "```",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
    ].join("\n");

    const html = noteContentToExportHtml(markdown, "", "markdown");

    expect(html).toContain("<h1>一级标题</h1>");
    expect(html).toContain("<h2>二级标题</h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<pre><code");
    expect(html).toContain("<table>");
    expect(html).not.toContain("# 一级标题");
  });
});

describe("exportSingleNote", () => {
  it("routes a note with attachments through the flat server ZIP job", async () => {
    vi.spyOn(api, "getNote").mockResolvedValue({
      id: "note-1",
      title: "资料分析模块",
      content: JSON.stringify({
        type: "doc",
        content: [{
          type: "image",
          attrs: { src: "/api/attachments/att-1", alt: "图" },
        }],
      }),
      contentText: "图",
      contentFormat: "tiptap-json",
      createdAt: "2026-07-11 10:00:00",
      updatedAt: "2026-07-11 10:00:00",
    } as Awaited<ReturnType<typeof api.getNote>>);
    const createJob = vi.spyOn(api, "createMarkdownExportJob").mockResolvedValue({
      job: {
        id: "job-1",
        state: "ready",
        current: 1,
        total: 1,
        message: "导出完成",
        filename: "资料分析模块.zip",
        downloadToken: "token-1",
        warnings: 0,
      },
    });
    const download = vi.spyOn(api, "downloadMarkdownExport").mockImplementation(() => {});

    await expect(exportSingleNote("note-1")).resolves.toBe(true);

    expect(createJob).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "note-1", title: "资料分析模块" })],
      expect.objectContaining({ layout: "flat", filenameBase: "资料分析模块" }),
    );
    expect(download).toHaveBeenCalledWith("token-1", "资料分析模块.zip");
  });
});

describe("printNote", () => {
  it("renders the current note and sends it to the platform print bridge", async () => {
    requestNotePrint.mockResolvedValue({ ok: true, mode: "web" });

    await expect(printNote({
      title: "打印测试",
      content: "# 正文标题",
      contentText: "正文标题",
      contentFormat: "markdown",
      createdAt: "2026-07-14 10:00:00",
      updatedAt: "2026-07-14 11:00:00",
    })).resolves.toEqual({ ok: true, mode: "web" });

    expect(requestNotePrint).toHaveBeenCalledWith(
      expect.stringContaining("<h1 class=\"title\">打印测试</h1>"),
      "打印测试",
    );
    expect(requestNotePrint.mock.calls[0][0]).toContain("<h1>正文标题</h1>");
  });
});
