import { afterEach, describe, expect, it, vi } from "vitest";
import { assertExportCanvasHasContent, assertExportHtmlHasContent } from "@/lib/exportCanvasGuard";

afterEach(() => {
  vi.restoreAllMocks();
});

function canvas(width: number, height: number, pixels?: Uint8ClampedArray): HTMLCanvasElement {
  return {
    width,
    height,
    getContext: () => ({
      getImageData: () => ({ data: pixels || new Uint8ClampedArray(width * height * 4).fill(255) }),
    }),
  } as unknown as HTMLCanvasElement;
}

describe("export canvas guard", () => {
  it("rejects zero-sized and background-only captures before they are saved", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => assertExportCanvasHasContent(canvas(0, 10), "note-pdf")).toThrow(/未正确渲染/);
    expect(() => assertExportCanvasHasContent(canvas(10, 10), "note-image")).toThrow(/未正确渲染/);
  });

  it("allows a canvas with rendered content", () => {
    const pixels = new Uint8ClampedArray(10 * 10 * 4).fill(255);
    for (let pixel = 10; pixel < 20; pixel += 1) {
      pixels[pixel * 4] = 0;
      pixels[pixel * 4 + 1] = 0;
      pixels[pixel * 4 + 2] = 0;
    }
    expect(() => assertExportCanvasHasContent(canvas(10, 10, pixels), "mindmap-png")).not.toThrow();
  });

  it("checks later bands of a tall page instead of only its blank top", () => {
    const tallCanvas = {
      width: 10,
      height: 2500,
      getContext: () => ({
        getImageData: (_x: number, y: number, width: number, height: number) => {
          const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
          if (y > 0) pixels.fill(0, 40, 80);
          return { data: pixels };
        },
      }),
    } as unknown as HTMLCanvasElement;
    expect(() => assertExportCanvasHasContent(tallCanvas, "note-image")).not.toThrow();
  });

  it("fails closed if the canvas cannot be inspected", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unreadable = { width: 10, height: 10, getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => assertExportCanvasHasContent(unreadable, "note-image")).toThrow(/未正确渲染/);
  });
});

describe("export content guard", () => {
  it("rejects a lost document body even when the title can still render", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => assertExportHtmlHasContent("Important note", "<p></p>", "note-pdf-web")).toThrow(/未正确渲染/);
  });

  it("allows text, media, and an intentionally empty note", () => {
    expect(() => assertExportHtmlHasContent("Important note", "<p>Important note</p>", "note-image")).not.toThrow();
    expect(() => assertExportHtmlHasContent("Image note", '<img src="data:image/png;base64,AA==">', "note-image")).not.toThrow();
    expect(() => assertExportHtmlHasContent("", "<p></p>", "note-pdf-web")).not.toThrow();
  });
});
