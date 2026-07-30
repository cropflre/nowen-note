import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  renderImageEditorCropOverlay,
  renderImageEditorDraft,
  renderImageEditorOperations,
} from "../imageCanvas";
import type { ImageEditorOperation } from "../imageEditorOperations";

function sourceImage(width: number, height: number): CanvasImageSource {
  return {
    width,
    height,
    naturalWidth: width,
    naturalHeight: height,
  } as unknown as CanvasImageSource;
}

describe("renderImageEditorOperations", () => {
  const contexts: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    vi.restoreAllMocks();
    contexts.length = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      const context = {
        arc: vi.fn(),
        beginPath: vi.fn(),
        clearRect: vi.fn(),
        clip: vi.fn(),
        closePath: vi.fn(),
        drawImage: vi.fn(),
        ellipse: vi.fn(),
        fillRect: vi.fn(),
        fillText: vi.fn(),
        lineTo: vi.fn(),
        moveTo: vi.fn(),
        rect: vi.fn(),
        restore: vi.fn(),
        rotate: vi.fn(),
        save: vi.fn(),
        scale: vi.fn(),
        setLineDash: vi.fn(),
        stroke: vi.fn(),
        strokeRect: vi.fn(),
        translate: vi.fn(),
      };
      contexts.push(context);
      return context as unknown as CanvasRenderingContext2D;
    });
  });

  it("applies rotation and crop in operation order", () => {
    const operations: ImageEditorOperation[] = [
      { kind: "rotate", degrees: 90 },
      { kind: "crop", rect: { x: 20, y: 30, width: 100, height: 140 } },
    ];

    const canvas = renderImageEditorOperations({ image: sourceImage(640, 320), operations });

    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(140);
  });

  it("renders pen, arrow, rectangle, ellipse and text annotations", () => {
    const operations: ImageEditorOperation[] = [
      { kind: "pen", points: [{ x: 4, y: 5 }, { x: 40, y: 50 }], color: "#f00", lineWidth: 5 },
      { kind: "arrow", start: { x: 8, y: 9 }, end: { x: 80, y: 90 }, color: "#0f0", lineWidth: 6 },
      { kind: "rectangle", start: { x: 10, y: 20 }, end: { x: 110, y: 120 }, color: "#00f", lineWidth: 4 },
      { kind: "ellipse", start: { x: 12, y: 22 }, end: { x: 90, y: 100 }, color: "#fff", lineWidth: 4 },
      { kind: "text", point: { x: 16, y: 26 }, text: "Nowen\n笔记", color: "#fff", fontSize: 32 },
    ];

    renderImageEditorOperations({ image: sourceImage(320, 240), operations });

    const allContexts = contexts as Array<{
      ellipse: ReturnType<typeof vi.fn>;
      fillText: ReturnType<typeof vi.fn>;
      strokeRect: ReturnType<typeof vi.fn>;
    }>;
    expect(allContexts.some((context) => context.strokeRect.mock.calls.length > 0)).toBe(true);
    expect(allContexts.some((context) => context.ellipse.mock.calls.length > 0)).toBe(true);
    expect(allContexts.flatMap((context) => context.fillText.mock.calls).map((call) => call[0])).toEqual(["Nowen", "笔记"]);
  });

  it("renders mosaic through a pixelated copy clipped to the stroke", () => {
    const operations: ImageEditorOperation[] = [{
      kind: "mosaic",
      points: [{ x: 20, y: 20 }, { x: 80, y: 80 }],
      lineWidth: 36,
      blockSize: 12,
    }];

    renderImageEditorOperations({ image: sourceImage(320, 240), operations });

    const clipped = contexts.some((context) => (context.clip as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    const disabledSmoothing = contexts.some((context) => context.imageSmoothingEnabled === false);
    expect(clipped).toBe(true);
    expect(disabledSmoothing).toBe(true);
  });

  it("renders a draft on a transparent overlay without replaying the source image", () => {
    const source = document.createElement("canvas");
    source.width = 1200;
    source.height = 800;
    const overlay = document.createElement("canvas");
    const operation: ImageEditorOperation = {
      kind: "pen",
      points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
      color: "#f00",
      lineWidth: 12,
    };

    renderImageEditorDraft(source, overlay, operation);

    expect(overlay.width).toBe(1200);
    expect(overlay.height).toBe(800);
    expect(contexts.some((context) => (context.stroke as ReturnType<typeof vi.fn>).mock.calls.length > 0)).toBe(true);
  });

  it("bounds a high resolution draft overlay to display pixels", () => {
    const source = document.createElement("canvas");
    source.width = 4096;
    source.height = 3072;
    const overlay = document.createElement("canvas");

    renderImageEditorDraft(source, overlay, null, {
      width: 512,
      height: 384,
      pixelRatio: 2,
    });

    expect(overlay.width).toBe(1024);
    expect(overlay.height).toBe(768);
  });

  it("bounds a high resolution crop overlay to display pixels", () => {
    const source = document.createElement("canvas");
    source.width = 4096;
    source.height = 3072;
    const overlay = document.createElement("canvas");

    renderImageEditorCropOverlay(
      source,
      overlay,
      { x: 400, y: 300, width: 2000, height: 1500 },
      { width: 512, height: 384, pixelRatio: 2 },
    );

    expect(overlay.width).toBe(1024);
    expect(overlay.height).toBe(768);
  });
});
