import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportCanvasToBlob,
  renderImageToCanvas,
  type ImageEditTransform,
} from "../imageCanvas";

function mockCanvasApis() {
  const context = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    restore: vi.fn(),
    rotate: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
    configurable: true,
    value(callback: BlobCallback) {
      callback(new Blob(["image"], { type: "image/png" }));
    },
  });
}

function sourceImage(width: number, height: number): CanvasImageSource {
  return {
    width,
    height,
    naturalWidth: width,
    naturalHeight: height,
  } as unknown as CanvasImageSource;
}

describe("imageCanvas", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockCanvasApis();
  });

  it("swaps canvas width and height for 90 degree rotation", () => {
    const transform: ImageEditTransform = { rotate: 90, flipX: false, flipY: false };
    const canvas = renderImageToCanvas({ image: sourceImage(640, 320), transform });

    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(640);
  });

  it("keeps canvas width and height for 180 degree rotation", () => {
    const transform: ImageEditTransform = { rotate: 180, flipX: false, flipY: false };
    const canvas = renderImageToCanvas({ image: sourceImage(640, 320), transform });

    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(320);
  });

  it("renders flip transforms without throwing", () => {
    expect(() => {
      renderImageToCanvas({
        image: sourceImage(240, 120),
        transform: { rotate: 0, flipX: true, flipY: true },
      });
    }).not.toThrow();
  });

  it("exports canvas to a blob", async () => {
    const canvas = renderImageToCanvas({
      image: sourceImage(240, 120),
      transform: { rotate: 0, flipX: false, flipY: false },
    });

    await expect(exportCanvasToBlob(canvas)).resolves.toMatchObject({ type: "image/png" });
  });
});
