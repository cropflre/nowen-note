// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { exportSingleNoteAsPDF } from "@/lib/exportServiceCore";

const mocks = vi.hoisted(() => ({ html2canvas: vi.fn() }));
vi.mock("html2canvas", () => ({ default: mocks.html2canvas }));
vi.mock("jspdf", () => ({
  jsPDF: class {
    internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } };
    addImage() {}
    addPage() {}
    output() { return new Blob(["%PDF-1.4 fixture"]); }
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  mocks.html2canvas.mockReset();
});

function renderedCanvas(withContent: boolean): HTMLCanvasElement {
  const pixels = new Uint8ClampedArray(40 * 40 * 4).fill(255);
  if (withContent) pixels.fill(0, 40, 80);
  return {
    width: 40,
    height: 40,
    getContext: () => ({ getImageData: () => ({ data: pixels }) }),
    toDataURL: () => "data:image/jpeg;base64,AA==",
  } as unknown as HTMLCanvasElement;
}

describe("Web PDF blank export regression", () => {
  it.each([
    ["Markdown", "markdown", "# 中文标题\n\n- 第一项\n- 第二项\n\n```js\nconst x = 1\n```"],
    ["Tiptap", "tiptap-json", JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "富文本正文" }] }],
    })],
  ])("does not download a blank %s PDF", async (_label, contentFormat, content) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(api, "getNote").mockResolvedValue({
      id: "note-777",
      title: "导出回归",
      content,
      contentText: "中文正文",
      contentFormat,
      createdAt: "2026-09-24 10:00:00",
      updatedAt: "2026-09-24 12:00:00",
    } as Awaited<ReturnType<typeof api.getNote>>);
    const stage = vi.spyOn(api, "stageGeneratedExport");
    const download = vi.spyOn(api, "downloadMarkdownExport");
    mocks.html2canvas.mockResolvedValue(renderedCanvas(false));

    const result = await exportSingleNoteAsPDF("note-777");

    expect(result).toMatchObject({ ok: false, mode: "error", error: expect.stringContaining("未正确渲染") });
    expect(stage).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("stages a PDF when the rendered note has visible pixels", async () => {
    vi.spyOn(api, "getNote").mockResolvedValue({
      id: "note-777",
      title: "正常导出",
      content: "# 正文",
      contentText: "正文",
      contentFormat: "markdown",
      createdAt: "2026-09-24 10:00:00",
      updatedAt: "2026-09-24 12:00:00",
    } as Awaited<ReturnType<typeof api.getNote>>);
    const stage = vi.spyOn(api, "stageGeneratedExport").mockResolvedValue({
      downloadToken: "token",
      filename: "正常导出.pdf",
    } as Awaited<ReturnType<typeof api.stageGeneratedExport>>);
    const download = vi.spyOn(api, "downloadMarkdownExport").mockImplementation(() => undefined);
    mocks.html2canvas.mockResolvedValue(renderedCanvas(true));

    await expect(exportSingleNoteAsPDF("note-777")).resolves.toEqual({ ok: true, mode: "web" });
    expect(stage).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledWith("token", "正常导出.pdf");
  });
});
