import { describe, expect, it } from "vitest";
import { computeEditorImageTransformLayout } from "@/lib/editorImageTransformLayout";

describe("computeEditorImageTransformLayout", () => {
  it("swaps the visual frame for a landscape quarter turn", () => {
    const layout = computeEditorImageTransformLayout({
      requestedWidth: 800,
      naturalWidth: 1200,
      naturalHeight: 600,
      availableWidth: 700,
      rotation: 90,
    });

    expect(layout).toEqual({
      imageWidth: 700,
      imageHeight: 350,
      frameWidth: 350,
      frameHeight: 700,
      sideways: true,
    });
  });

  it("shrinks a portrait source before rotation so it cannot overflow horizontally", () => {
    const layout = computeEditorImageTransformLayout({
      requestedWidth: 600,
      naturalWidth: 600,
      naturalHeight: 1200,
      availableWidth: 400,
      rotation: 270,
    });

    expect(layout).toEqual({
      imageWidth: 200,
      imageHeight: 400,
      frameWidth: 400,
      frameHeight: 200,
      sideways: true,
    });
  });

  it("keeps normal and 180 degree images in their original layout orientation", () => {
    const normal = computeEditorImageTransformLayout({
      requestedWidth: 500,
      naturalWidth: 1000,
      naturalHeight: 500,
      availableWidth: 420,
      rotation: 0,
    });
    const upsideDown = computeEditorImageTransformLayout({
      requestedWidth: 500,
      naturalWidth: 1000,
      naturalHeight: 500,
      availableWidth: 420,
      rotation: 180,
    });

    expect(normal).toMatchObject({
      imageWidth: 420,
      imageHeight: 210,
      frameWidth: 420,
      frameHeight: 210,
      sideways: false,
    });
    expect(upsideDown).toEqual(normal);
  });

  it("returns null until the image has usable intrinsic dimensions", () => {
    expect(computeEditorImageTransformLayout({
      naturalWidth: 0,
      naturalHeight: 0,
      availableWidth: 400,
      rotation: 90,
    })).toBeNull();
  });
});
