import { describe, expect, it } from "vitest";
import { assetFileKind, chunkIds, folderPath, selectFile, toggleSelectPageIds } from "../fileExplorerModel";

describe("file explorer organization", () => {
  it("builds a real three-level breadcrumb and safely stops on legacy cycles", () => {
    const folders = [
      { id: "a", name: "A", parentId: null }, { id: "b", name: "B", parentId: "a" }, { id: "c", name: "C", parentId: "b" },
    ];
    expect(folderPath(folders, "c").map((folder) => folder.id)).toEqual(["a", "b", "c"]);
    expect(folderPath([{ ...folders[0], parentId: "b" }, folders[1]], "a")).toHaveLength(2);
  });
  it("supports range and modifier selection without accidentally retaining another page", () => {
    const ids = ["a", "b", "c", "d"];
    expect([...selectFile(new Set(["a"]), ids, "c", "a", { range: true })]).toEqual(["a", "b", "c"]);
    expect([...selectFile(new Set(["a"]), ids, "a", "a", { toggle: true })]).toEqual([]);
    expect([...selectFile(new Set(["old-page"]), ids, "b", "old-page", { range: true })]).toEqual(["b"]);
  });
  it("classifies media, documents and archives consistently without treating every file as a document", () => {
    expect(assetFileKind("video/mp4")).toBe("video");
    expect(assetFileKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("document");
    expect(assetFileKind("application/zip")).toBe("archive");
    expect(assetFileKind("application/octet-stream")).toBe("other");
  });
  it("chunks large batch IDs into 200-item slices and toggles page selection while keeping other pages", () => {
    const ids = Array.from({ length: 450 }, (_, index) => `id-${index}`);
    const chunks = chunkIds(ids);
    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 200, 50]);
    expect(chunkIds([])).toEqual([]);

    const withOtherPage = toggleSelectPageIds(new Set(["other-page-1"]), ["p1-a", "p1-b"]);
    expect([...withOtherPage]).toEqual(["other-page-1", "p1-a", "p1-b"]);
    const deselectedPage = toggleSelectPageIds(withOtherPage, ["p1-a", "p1-b"]);
    expect([...deselectedPage]).toEqual(["other-page-1"]);
  });
});
