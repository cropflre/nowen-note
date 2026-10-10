import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeMarkdownViewModeForMobile } from "../MarkdownEditorImpl";

const editorSource = readFileSync(
  path.resolve(__dirname, "../MarkdownEditorImpl.tsx"),
  "utf8",
);
const experienceBridgeSource = readFileSync(
  path.resolve(__dirname, "../MarkdownExperienceBridge.tsx"),
  "utf8",
);
const mobileBridgeSource = readFileSync(
  path.resolve(__dirname, "../MarkdownMobileViewControlsBridge.tsx"),
  "utf8",
);

describe("MarkdownEditor mobile preview", () => {
  it("falls back to source mode when a desktop split preference is opened on mobile", () => {
    expect(normalizeMarkdownViewModeForMobile("split", true)).toBe("source");
    expect(normalizeMarkdownViewModeForMobile("preview", true)).toBe("preview");
    expect(normalizeMarkdownViewModeForMobile("split", false)).toBe("split");
  });

  it("keeps the canonical mobile source and preview controls available", () => {
    const mobileControls = editorSource.slice(
      editorSource.indexOf("MARKDOWN-MOBILE-PREVIEW-01"),
      editorSource.indexOf("<ToolbarDivider />", editorSource.indexOf("MARKDOWN-MOBILE-PREVIEW-01")),
    );

    expect(mobileControls).toContain("sm:hidden");
    expect(mobileControls).toContain('setMarkdownViewMode("source")');
    expect(mobileControls).toContain('setMarkdownViewMode("preview")');
  });

  it("binds live preview through the responsive full toolbar instead of relying on the old sticky selector", () => {
    expect(experienceBridgeSource).toContain("data-markdown-mobile-toolbar");
    expect(experienceBridgeSource).toContain("expanded");
    expect(experienceBridgeSource).toContain("nowenMarkdownLive");
    expect(experienceBridgeSource).toContain("markdownLivePreviewExtension");
  });

  it("surfaces source, live preview and preview together on the compact mobile toolbar", () => {
    expect(mobileBridgeSource).toContain("data-nowen-markdown-live");
    expect(mobileBridgeSource).toContain("target.liveButton");
    expect(mobileBridgeSource).toContain("实时预览");
  });
});
