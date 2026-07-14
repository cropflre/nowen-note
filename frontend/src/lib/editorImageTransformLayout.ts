import type { ImageRotation } from "@/lib/imageNodeTransformBootstrap";

export interface EditorImageTransformLayoutInput {
  requestedWidth?: number | null;
  naturalWidth: number;
  naturalHeight: number;
  availableWidth: number;
  rotation: ImageRotation;
}

export interface EditorImageTransformLayout {
  imageWidth: number;
  imageHeight: number;
  frameWidth: number;
  frameHeight: number;
  sideways: boolean;
}

function positive(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/**
 * CSS transforms do not participate in normal document flow. A 90°/270° image therefore
 * needs an axis-aligned frame whose width/height are swapped, otherwise the visual pixels
 * overlap the following paragraph while the editor still reserves the unrotated rectangle.
 *
 * The returned image dimensions always fit the editor column. Portrait images are reduced
 * before a quarter turn so their rotated width cannot exceed the available content width.
 */
export function computeEditorImageTransformLayout(
  input: EditorImageTransformLayoutInput,
): EditorImageTransformLayout | null {
  const naturalWidth = positive(input.naturalWidth);
  const naturalHeight = positive(input.naturalHeight);
  if (!naturalWidth || !naturalHeight) return null;

  const ratio = naturalWidth / naturalHeight;
  const availableWidth = positive(input.availableWidth) || naturalWidth;
  const requestedWidth = positive(input.requestedWidth) || naturalWidth;
  const sideways = input.rotation === 90 || input.rotation === 270;

  // For a portrait source, the rotated visual width is imageWidth / ratio. Limit the
  // unrotated width first so the final visual frame remains inside the editor column.
  const maxImageWidth = sideways && ratio < 1
    ? availableWidth * ratio
    : availableWidth;
  const imageWidth = Math.max(1, Math.min(requestedWidth, maxImageWidth));
  const imageHeight = imageWidth / ratio;

  return {
    imageWidth,
    imageHeight,
    frameWidth: sideways ? imageHeight : imageWidth,
    frameHeight: sideways ? imageWidth : imageHeight,
    sideways,
  };
}
