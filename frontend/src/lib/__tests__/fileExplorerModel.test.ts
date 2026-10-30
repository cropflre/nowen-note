import { describe, expect, it } from "vitest";
import { assetFileKind, folderPath, selectFile } from "../fileExplorerModel";

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
});
