// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { saveAs } from "file-saver";
import { exportNoteImageDetailed } from "@/lib/noteImageExportCore";

const mocks = vi.hoisted(() => ({
  html2canvas: vi.fn(),
  isAndroidNative: vi.fn(() => false),
  saveImageToGalleryDetailed: vi.fn(),
}));
vi.mock("html2canvas", () => ({ default: mocks.html2canvas }));
vi.mock("file-saver", () => ({ saveAs: vi.fn() }));
vi.mock("@/lib/nativeImageSave", () => ({
  isAndroidNative: mocks.isAndroidNative,
  saveImageToGalleryDetailed: mocks.saveImageToGalleryDetailed,
  saveBlobToSystemFile: vi.fn(),
  shareNativeFiles: vi.fn(),
}));

const note = {
  id: "note-777",
  title: "正文与坏图",
  content: "正文仍需导出\n\n![坏图](https://example.invalid/missing.png)",
  contentText: "正文仍需导出",
  contentFormat: "markdown",
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.html2canvas.mockReset();
  mocks.isAndroidNative.mockReset().mockReturnValue(false);
  mocks.saveImageToGalleryDetailed.mockReset();
  vi.mocked(saveAs).mockClear();
});

function renderCanvas(): HTMLCanvasElement {
  const pixels = new Uint8ClampedArray(40 * 40 * 4).fill(255);
  pixels.fill(0, 40, 80);
  return {
    width: 40,
    height: 40,
    getContext: () => ({ getImageData: () => ({ data: pixels }) }),
    toBlob: (callback: BlobCallback) => callback(new Blob(["raster"], { type: "image/png" })),
  } as unknown as HTMLCanvasElement;
}

function prepareMocks() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 404 })));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(1);
  mocks.html2canvas.mockImplementation(async (clone: HTMLElement) => {
    expect(clone.querySelector(".nowen-note-image-export-body")?.textContent).toContain("正文仍需导出");
    expect(clone.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    return renderCanvas();
  });
}

describe("note image export failure routing", () => {
  it("keeps the body and reports a failed external image while saving PNG", async () => {
    prepareMocks();

    const result = await exportNoteImageDetailed(note, { format: "png", destination: "download" });

    expect(result.ok).toBe(true);
    expect(result.failedResources).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: "https://example.invalid/missing.png", reason: "HTTP 404" }),
    ]));
    expect(result.warnings.join(" ")).toContain("占位图");
    expect(saveAs).toHaveBeenCalledOnce();
  });

  it("does not report Android gallery success when native saving fails", async () => {
    prepareMocks();
    mocks.isAndroidNative.mockReturnValue(true);
    mocks.saveImageToGalleryDetailed.mockRejectedValue(new Error("gallery unavailable"));

    const result = await exportNoteImageDetailed(note, { format: "png", destination: "gallery" });

    expect(result).toMatchObject({ ok: false, error: "gallery unavailable" });
    expect(saveAs).not.toHaveBeenCalled();
  });
});
