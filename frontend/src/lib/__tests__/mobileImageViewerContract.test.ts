import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("mobile image viewer contract", () => {
  it("keeps close controls outside the gesture stage and handles Android back", () => {
    const viewer = source("../../components/MobileImageViewer.tsx");

    expect(viewer).toContain('data-nowen-mobile-image-viewer=""');
    expect(viewer).toContain('style={{ touchAction: "none" }}');
    expect(viewer).toContain("onPointerDown={handleClosePointerDown}");
    expect(viewer).toContain('CapacitorApp.addListener("backButton"');
    expect(viewer).toContain("const MIN_SCALE = 1");
    expect(viewer).toContain("const MAX_SCALE = 5");
    expect(viewer).toContain("setPointerCapture");
    expect(viewer).toContain("releasePointerCapture");
  });

  it("intercepts Markdown images before their external-open handler and mirrors Tiptap previews", () => {
    const bridge = source("../../components/MobileImageViewerBridge.tsx");

    expect(bridge).toContain('document.addEventListener("click", handleMarkdownImageClick, true)');
    expect(bridge).toContain('closest<HTMLImageElement>(".nowen-md-preview img")');
    expect(bridge).toContain("event.preventDefault()");
    expect(bridge).toContain("event.stopImmediatePropagation()");
    expect(bridge).toContain("findNativeTiptapPreview()");
    expect(bridge).toContain('img[alt="preview"]');
  });
});
