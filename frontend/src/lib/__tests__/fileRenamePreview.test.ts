import { expect, it } from "vitest";
import { fileRenamePreview } from "../fileRenamePreview";

it("previews stable numbered names with mixed extensions, dotfiles and extensionless files", () => {
  const files = ["old.PNG", "document.pdf", "README", ".env"].map(
    (filename, index) => ({ id: String(index), filename }),
  );
  const preview = fileRenamePreview(files, "  项目  ", 9);
  expect(preview.map((item) => item.filename)).toEqual([
    "项目-009.PNG",
    "项目-010.pdf",
    "项目-011",
    "项目-012",
  ]);
  expect(preview.map((item) => item.expectedFilename)).toEqual(
    files.map((item) => item.filename),
  );
});
it("rejects invalid and oversized names, empty or oversized batches and unsafe numbers", () => {
  const files = [{ id: "a", filename: "old.pdf" }];
  for (const base of [
    "",
    " ",
    "unsafe/part",
    "unsafe\\part",
    "unsafe\npart",
    "x".repeat(255),
  ])
    expect(fileRenamePreview(files, base, 1)).toEqual([]);
  for (const start of [0, 1.2, NaN, 1000000])
    expect(fileRenamePreview(files, "Safe", start)).toEqual([]);
  expect(fileRenamePreview([], "Safe", 1)).toEqual([]);
  expect(fileRenamePreview(Array(201).fill(files[0]), "Safe", 1)).toEqual([]);
  expect(fileRenamePreview(files, "Safe", 999999)[0].filename).toBe(
    "Safe-999999.pdf",
  );
});
