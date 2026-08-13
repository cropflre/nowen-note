import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("mobile image viewer contract", () => {
  it("keeps close controls outside the gesture stage and joins the shared Android back stack", () => {
    const viewer = source("../../components/FullscreenImageViewer.tsx");

    expect(viewer).toContain('data-nowen-mobile-image-viewer=""');
    expect(viewer).toContain('touchAction: "none"');
    expect(viewer).toContain("onPointerDown={handleClosePointerDown}");
    expect(viewer).toContain('registerMobileBackHandler("image-viewer"');
    expect(viewer).not.toContain('addListener("backButton"');
    expect(viewer).toContain("const MIN_SCALE = 1");
    expect(viewer).toContain("const MAX_SCALE = 5");
    expect(viewer).toContain("setPointerCapture");
    expect(viewer).toContain("releasePointerCapture");
    expect(viewer).toContain("navigateGallery");
    expect(viewer).toContain("rotateClockwise");
    expect(viewer).toContain("复原缩放、旋转和位置");
    expect(viewer).toContain("canEdit?: boolean");
    expect(viewer).toContain("onEdit?:");
    expect(viewer).toContain('aria-label="编辑图片"');
  });

  it("uses explicit React viewer entry points instead of a DOM observer bridge", () => {
    const tiptap = source("../../components/TiptapEditor.tsx");
    const markdown = source("../../components/MarkdownPreview.tsx");
    const shared = source("../../components/SharedNoteView.tsx");

    expect(tiptap).toContain("<FullscreenImageViewer");
    expect(markdown).toContain("<FullscreenImageViewer");
    expect(shared).toContain("<FullscreenImageViewer");
    expect(tiptap).not.toContain("<MobileImageViewer");
  });
});
