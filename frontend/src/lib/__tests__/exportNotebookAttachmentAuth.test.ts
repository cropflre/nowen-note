import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getExportNotes, resolveAttachmentUrl, saveAs } = vi.hoisted(() => ({
  getExportNotes: vi.fn(),
  resolveAttachmentUrl: vi.fn((src: string) => src),
  saveAs: vi.fn(),
}));

vi.mock("file-saver", () => ({ saveAs }));
vi.mock("@/lib/api", () => ({
  api: { getExportNotes },
  resolveAttachmentUrl,
}));

import { exportNotebook } from "@/lib/exportServiceCore";

describe("notebook attachment export authentication", () => {
  beforeEach(() => {
    localStorage.clear();
    getExportNotes.mockReset();
    resolveAttachmentUrl.mockClear();
    saveAs.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the current login token when downloading Markdown attachments", async () => {
    localStorage.setItem("nowen-token", "export-token");
    getExportNotes.mockResolvedValue([{
      id: "note-1",
      title: "带图笔记",
      content: "![截图](/api/attachments/11fe46d6-1a50-4a3b-b251-8486a1e7e9ea)",
      contentText: "截图",
      contentFormat: "markdown",
      notebookId: "notebook-1",
      notebookName: "需求文档",
      createdAt: "2026-07-17 10:00:00",
      updatedAt: "2026-07-17 10:00:00",
    }]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exportNotebook({
      notebookId: "notebook-1",
      notebookName: "需求文档",
      descendantNotebookIds: new Set(["notebook-1"]),
    })).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/attachments/11fe46d6-1a50-4a3b-b251-8486a1e7e9ea",
      expect.objectContaining({
        credentials: "include",
        headers: { Authorization: "Bearer export-token" },
      }),
    );
    expect(saveAs).toHaveBeenCalledTimes(1);
  });
});
