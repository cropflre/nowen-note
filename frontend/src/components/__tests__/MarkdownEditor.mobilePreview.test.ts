import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeMarkdownViewModeForMobile } from "../MarkdownEditorImpl";

const editorSource = readFileSync(
  path.resolve(__dirname, "../MarkdownEditorImpl.tsx"),
  "utf8",
);

describe("MarkdownEditor mobile preview", () => {
  it("falls back to source mode when a desktop split preference is opened on mobile", () => {
    expect(normalizeMarkdownViewModeForMobile("split", true)).toBe("source");
    expect(normalizeMarkdownViewModeForMobile("preview", true)).toBe("preview");
    expect(normalizeMarkdownViewModeForMobile("split", false)).toBe("split");
  });

  it("places the mobile edit and preview controls before formatting tools", () => {
    const mobileControls = editorSource.slice(
      editorSource.indexOf("MARKDOWN-MOBILE-PREVIEW-01"),
      editorSource.indexOf("<ToolbarDivider />", editorSource.indexOf("MARKDOWN-MOBILE-PREVIEW-01")),
    );

    expect(mobileControls).toContain("sm:hidden");
    expect(mobileControls).toContain('setMarkdownViewMode("source")');
    expect(mobileControls).toContain('setMarkdownViewMode("preview")');
  });
});
