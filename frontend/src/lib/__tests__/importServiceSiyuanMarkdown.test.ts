import { afterEach, describe, expect, it, vi } from "vitest";

const importNotesMock = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    importNotes: importNotesMock,
  },
}));

describe("importService Siyuan Markdown import", () => {
  afterEach(() => {
    importNotesMock.mockReset();
  });

  it("sends Siyuan Markdown zip notes as native Markdown without converting to TipTap JSON", async () => {
    importNotesMock.mockResolvedValue({ success: true, count: 1 });
    const { importNotes } = await import("@/lib/importService");

    await importNotes([
      {
        name: "Notebook/Doc.md",
        title: "Doc",
        content: "# Doc\n\n- item\n\n![pic](assets/a.png)\n",
        size: 32,
        selected: true,
        source: "siyuan",
        imageMap: {
          "assets/a.png": "data:image/png;base64,aW1hZ2U=",
        },
      },
    ]);

    const [[notes]] = importNotesMock.mock.calls;
    expect(notes[0].contentFormat).toBe("markdown");
    expect(notes[0].content).toContain("# Doc");
    expect(notes[0].content).toContain("- item");
    expect(notes[0].content).toContain("![pic](data:image/png;base64,aW1hZ2U=)");
    expect(notes[0].content).not.toMatch(/^\s*\{"type":"doc"/);
  });

  it("sends native Siyuan .sy notes as Markdown but keeps ordinary Markdown imports as rich text", async () => {
    importNotesMock.mockResolvedValue({ success: true, count: 2 });
    const { importNotes } = await import("@/lib/importService");

    await importNotes([
      {
        name: "data/doc.sy",
        title: "Sy Doc",
        content: "## Sy Doc\n\nbody",
        size: 16,
        selected: true,
        source: "siyuan-sy",
      },
      {
        name: "plain.md",
        title: "Plain",
        content: "# Plain",
        size: 7,
        selected: true,
        source: "md",
      },
    ]);

    const [[notes]] = importNotesMock.mock.calls;
    expect(notes[0].contentFormat).toBe("markdown");
    expect(notes[0].content).toContain("## Sy Doc");
    expect(notes[1].contentFormat).toBe("tiptap-json");
    expect(notes[1].content).toMatch(/^\s*\{"type":"doc"/);
  });
});
