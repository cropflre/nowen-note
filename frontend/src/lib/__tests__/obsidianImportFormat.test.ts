import { afterEach, describe, expect, it, vi } from "vitest";

const importNotesMock = vi.fn();
const updateNoteMock = vi.fn();
const getNoteMock = vi.fn();
const uploadMock = vi.fn();

vi.mock("../api", () => ({
  api: {
    importNotes: importNotesMock,
    updateNote: updateNoteMock,
    getNote: getNoteMock,
    attachments: { upload: uploadMock },
  },
}));

function scanFor(markdown: string) {
  const file = {
    name: "Demo.md",
    size: new TextEncoder().encode(markdown).byteLength,
    type: "text/markdown",
    lastModified: 1_700_000_000_000,
    text: async () => markdown,
  } as unknown as File;
  return {
    source: "folder" as const,
    rootFolderName: "Vault",
    entries: [{
      relPath: "Vault/Demo.md",
      vaultPath: "Demo.md",
      fileName: "Demo.md",
      notebookPath: [],
      size: file.size,
      lastModified: file.lastModified,
      kind: "note" as const,
      selected: true,
      file,
    }],
    stats: { notes: 1, attachments: 0, images: 0, videos: 0, pdfs: 0, skipped: 0, folders: 0, totalBytes: file.size },
  };
}

describe("Obsidian import target format", () => {
  afterEach(() => {
    importNotesMock.mockReset();
    updateNoteMock.mockReset();
    getNoteMock.mockReset();
    uploadMock.mockReset();
  });

  it("keeps rewritten Obsidian content as native Markdown", async () => {
    importNotesMock.mockResolvedValue({ success: true, count: 1, notes: [{ id: "n1", version: 1 }] });
    updateNoteMock.mockResolvedValue({ success: true });
    const { runObsidianImport } = await import("@/lib/obsidianImportService");

    const result = await runObsidianImport(scanFor("---\ntags: [demo]\n---\n# Demo\n\nBody"), {
      rootName: "Vault",
      contentFormat: "markdown",
    });

    expect(result.noteCount).toBe(1);
    expect(importNotesMock.mock.calls[0][0][0].contentFormat).toBe("markdown");
    const finalUpdate = updateNoteMock.mock.calls.at(-1)?.[1];
    expect(finalUpdate.contentFormat).toBe("markdown");
    expect(finalUpdate.content).toContain("tags: [demo]");
    expect(finalUpdate.content).toContain("# Demo");
  });

  it("converts Obsidian Markdown to TipTap JSON when rich text is selected", async () => {
    importNotesMock.mockResolvedValue({ success: true, count: 1, notes: [{ id: "n2", version: 1 }] });
    updateNoteMock.mockResolvedValue({ success: true });
    const { runObsidianImport } = await import("@/lib/obsidianImportService");

    const result = await runObsidianImport(scanFor("# Demo\n\n**Body**"), {
      rootName: "Vault",
      contentFormat: "tiptap-json",
    });

    expect(result.noteCount).toBe(1);
    expect(importNotesMock.mock.calls[0][0][0].contentFormat).toBe("tiptap-json");
    const finalUpdate = updateNoteMock.mock.calls.at(-1)?.[1];
    expect(finalUpdate.contentFormat).toBe("tiptap-json");
    expect(finalUpdate.content).toMatch(/^\s*\{"type":"doc"/);
  });
});
