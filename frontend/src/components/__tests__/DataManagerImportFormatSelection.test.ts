import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.resolve(__dirname, "../DataManager.tsx"),
  "utf8",
);

describe("DataManager SiYuan import format selection", () => {
  it("does not overwrite an explicit or persisted Markdown choice during file inspection", () => {
    expect(source).toContain("hasPersistedImportFormat(IMPORT_FORMAT_STORAGE.siyuan)");
    expect(source).toContain("siyuanImportFormatUserSelectedRef.current = true");
    expect(source).toContain("if (siyuanImportFormatUserSelectedRef.current) return;");

    const processStart = source.indexOf("const processFiles = async");
    const processEnd = source.indexOf("const toggleFileSelection", processStart);
    expect(processStart).toBeGreaterThanOrEqual(0);
    expect(processEnd).toBeGreaterThan(processStart);
    const processSource = source.slice(processStart, processEnd);

    expect(processSource).toContain('recommendSiyuanImportContentFormat("tiptap-json")');
    expect(processSource).toContain('recommendSiyuanImportContentFormat("markdown")');
    expect(processSource).not.toContain('setSiyuanImportContentFormat("tiptap-json")');
    expect(processSource).not.toContain('setSiyuanImportContentFormat("markdown")');

    expect(source).toContain(
      'onClick={() => selectSiyuanImportContentFormat("markdown")}',
    );
    expect(source).toContain(
      'onClick={() => selectSiyuanImportContentFormat("tiptap-json")}',
    );
  });
});
