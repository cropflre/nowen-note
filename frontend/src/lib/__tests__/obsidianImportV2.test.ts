import { beforeEach, describe, expect, it, vi } from "vitest";

const importNotesMock = vi.fn();
const updateNoteMock = vi.fn();
const getNoteMock = vi.fn();
const resolveOriginsMock = vi.fn();
const registerOriginMock = vi.fn();
const uploadMock = vi.fn();
const linkFileMock = vi.fn();

vi.mock("../api", () => ({
  api: {
    importNotes: importNotesMock,
    updateNote: updateNoteMock,
    getNote: getNoteMock,
    resolveImportOrigins: resolveOriginsMock,
    registerImportOrigin: registerOriginMock,
    files: { upload: uploadMock },
  },
}));

vi.mock("../knowledgeTreeApi", () => ({
  knowledgeTreeApi: { linkFile: linkFileMock },
}));

function fileAt(path: string, content: string, type: string): File {
  const name = path.split("/").pop() || path;
  const file = new File([content], name, {
    type,
    lastModified: 1_700_000_000_000,
  });
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  Object.defineProperty(file, "text", { value: async () => content });
  return file;
}

function scanFixture() {
  const files = [
    fileAt("Vault/docs/A.md", "# A\n\n![[../assets/shared.png]]", "text/markdown"),
    fileAt("Vault/docs/B.md", "# B\n\n![same](../assets/shared.png)", "text/markdown"),
    fileAt("Vault/assets/shared.png", "image", "image/png"),
    fileAt("Vault/assets/unused.pdf", "pdf", "application/pdf"),
  ];
  const entries = files.map((file, index) => {
    const vaultPath = String((file as File & { webkitRelativePath?: string }).webkitRelativePath)
      .replace(/^Vault\//, "");
    const parts = vaultPath.split("/");
    const note = index < 2;
    return {
      relPath: `Vault/${vaultPath}`,
      vaultPath,
      fileName: parts.at(-1)!,
      notebookPath: parts.slice(0, -1),
      size: file.size,
      lastModified: file.lastModified,
      kind: note ? "note" as const : index === 2 ? "image" as const : "pdf" as const,
      selected: true,
      file,
    };
  });
  return {
    source: "folder" as const,
    rootFolderName: "Vault",
    entries,
    stats: {
      notes: 2,
      attachments: 2,
      images: 1,
      videos: 0,
      pdfs: 1,
      skipped: 0,
      folders: 2,
      totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    },
  };
}

describe("Obsidian Import V2 (#763)", () => {
  beforeEach(() => {
    importNotesMock.mockReset();
    updateNoteMock.mockReset();
    getNoteMock.mockReset();
    resolveOriginsMock.mockReset();
    registerOriginMock.mockReset();
    uploadMock.mockReset();
    linkFileMock.mockReset();

    resolveOriginsMock.mockResolvedValue({ origins: {} });
    importNotesMock
      .mockResolvedValueOnce({ success: true, count: 1, notes: [{ id: "note-a", version: 1 }] })
      .mockResolvedValueOnce({ success: true, count: 1, notes: [{ id: "note-b", version: 1 }] });
    registerOriginMock.mockImplementation(async (input: { noteId: string }) => ({
      created: true,
      conflict: false,
      noteId: input.noteId,
    }));
    uploadMock.mockResolvedValue({
      id: "file-shared",
      url: "/api/attachments/file-shared",
      filename: "shared.png",
      mimeType: "image/png",
      size: 5,
      createdAt: new Date(0).toISOString(),
      category: "image",
    });
    linkFileMock.mockResolvedValue({ id: "file:file-shared" });
  });

  it("reports one-based note progress and uploads a shared referenced asset only once", async () => {
    const progress: Array<{ current: number; total: number; message: string }> = [];
    const { runObsidianImport } = await import("@/lib/obsidianImportService");

    const result = await runObsidianImport(scanFixture(), {
      rootName: "Imported Vault",
      contentFormat: "markdown",
      onProgress: (entry) => progress.push(entry),
    });

    expect(progress[0]).toMatchObject({
      current: 1,
      total: 2,
      message: "解析 1/2: docs/A.md",
    });
    expect(progress[1]).toMatchObject({
      current: 2,
      total: 2,
      message: "解析 2/2: docs/B.md",
    });

    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(linkFileMock).toHaveBeenCalledTimes(1);
    expect(linkFileMock).toHaveBeenCalledWith({
      fileId: "file-shared",
      notebookPath: ["Imported Vault", "assets"],
    });
    expect(importNotesMock).toHaveBeenCalledTimes(2);
    expect(importNotesMock.mock.calls[0][0][0].content).toContain("/api/attachments/file-shared");
    expect(importNotesMock.mock.calls[1][0][0].content).toContain("/api/attachments/file-shared");
    expect(result.createdCount).toBe(2);
    expect(result.attachmentCount).toBe(1);
    expect(result.fileNodeCount).toBe(1);
    expect(result.unusedAttachmentCount).toBe(1);
    expect(result.warnings).toContain("1 个未被笔记引用的附件未上传");
  });

  it("skips a previously imported source without creating a duplicate", async () => {
    resolveOriginsMock.mockResolvedValue({
      origins: {
        "Vault/docs/A.md": {
          externalId: "Vault/docs/A.md",
          noteId: "existing-a",
          title: "A",
          notebookId: "nb-a",
          version: 7,
          updatedAt: "2026-09-01T00:00:00Z",
          isTrashed: 0,
        },
        "Vault/docs/B.md": {
          externalId: "Vault/docs/B.md",
          noteId: "existing-b",
          title: "B",
          notebookId: "nb-a",
          version: 2,
          updatedAt: "2026-09-01T00:00:00Z",
          isTrashed: 0,
        },
      },
    });
    const { runObsidianImport } = await import("@/lib/obsidianImportService");

    const result = await runObsidianImport(scanFixture(), {
      rootName: "Imported Vault",
      contentFormat: "markdown",
      duplicateStrategy: "skip",
    });

    expect(importNotesMock).not.toHaveBeenCalled();
    expect(updateNoteMock).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(2);
    expect(result.noteCount).toBe(0);
    expect(result.success).toBe(true);
  });

  it("updates a previously imported source when update strategy is selected", async () => {
    const scan = scanFixture();
    scan.entries = scan.entries.filter((entry) => entry.vaultPath === "docs/A.md");
    scan.stats.notes = 1;
    scan.stats.attachments = 0;
    scan.stats.images = 0;
    scan.stats.pdfs = 0;

    resolveOriginsMock.mockResolvedValue({
      origins: {
        "Vault/docs/A.md": {
          externalId: "Vault/docs/A.md",
          noteId: "existing-a",
          title: "Old A",
          notebookId: "nb-a",
          version: 3,
          updatedAt: "2026-09-01T00:00:00Z",
          isTrashed: 0,
        },
      },
    });
    getNoteMock.mockResolvedValue({ id: "existing-a", version: 3 });
    updateNoteMock.mockResolvedValue({ id: "existing-a", version: 4 });

    const { runObsidianImport } = await import("@/lib/obsidianImportService");
    const result = await runObsidianImport(scan, {
      rootName: "Imported Vault",
      contentFormat: "markdown",
      duplicateStrategy: "update",
    });

    expect(importNotesMock).not.toHaveBeenCalled();
    expect(updateNoteMock).toHaveBeenCalledWith("existing-a", expect.objectContaining({
      title: "A",
      contentFormat: "markdown",
      version: 3,
    }));
    expect(result.updatedCount).toBe(1);
    expect(result.createdCount).toBe(0);
  });

  it("imports unreferenced attachments as independent tree files only when enabled", async () => {
    uploadMock
      .mockResolvedValueOnce({
        id: "file-shared",
        url: "/api/attachments/file-shared",
        filename: "shared.png",
        mimeType: "image/png",
        size: 5,
        createdAt: new Date(0).toISOString(),
        category: "image",
      })
      .mockResolvedValueOnce({
        id: "file-unused",
        url: "/api/attachments/file-unused",
        filename: "unused.pdf",
        mimeType: "application/pdf",
        size: 3,
        createdAt: new Date(0).toISOString(),
        category: "file",
      });

    const { runObsidianImport } = await import("@/lib/obsidianImportService");
    const result = await runObsidianImport(scanFixture(), {
      rootName: "Imported Vault",
      contentFormat: "markdown",
      includeUnusedAttachments: true,
    });

    expect(uploadMock).toHaveBeenCalledTimes(2);
    expect(linkFileMock).toHaveBeenCalledWith({
      fileId: "file-unused",
      notebookPath: ["Imported Vault", "assets"],
    });
    expect(result.attachmentCount).toBe(2);
    expect(result.fileNodeCount).toBe(2);
    expect(result.warnings).toContain("1 个未引用附件已作为独立文件导入目录树");
  });

  it("keeps the original source identity even when the destination root is renamed", async () => {
    const { obsidianExternalId } = await import("@/lib/obsidianImportService");
    const scan = scanFixture();
    const note = scan.entries.find((entry) => entry.kind === "note")!;
    expect(obsidianExternalId(scan, note)).toBe("Vault/docs/A.md");
  });
});
