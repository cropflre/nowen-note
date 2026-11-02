export type ImageViewerPoint = { x: number; y: number };

/** Pan bounds use the rotated bitmap, not its unrotated DOM frame. */
export function clampImageViewerPosition(
  position: ImageViewerPoint,
  scale: number,
  rotation: number,
  image: { width: number; height: number },
  stage: { width: number; height: number },
): ImageViewerPoint {
  if (scale <= 1) return { x: 0, y: 0 };
  const sideways = rotation % 180 !== 0;
  const maxX = Math.max(0, ((sideways ? image.height : image.width) * scale - stage.width) / 2);
  const maxY = Math.max(0, ((sideways ? image.width : image.height) * scale - stage.height) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, position.x)),
    y: Math.min(maxY, Math.max(-maxY, position.y)),
  };
}
