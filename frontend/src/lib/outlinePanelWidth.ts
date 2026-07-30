export const OUTLINE_WIDTH_STORAGE_KEY = "nowen-outline-width";
export const DEFAULT_OUTLINE_WIDTH = 224;
export const MIN_OUTLINE_WIDTH = 200;
export const MAX_OUTLINE_WIDTH = 480;

export function clampOutlineWidth(width: number): number {
  return Math.max(MIN_OUTLINE_WIDTH, Math.min(MAX_OUTLINE_WIDTH, width));
}

export function getSavedOutlineWidth(): number {
  try {
    const saved = localStorage.getItem(OUTLINE_WIDTH_STORAGE_KEY);
    if (saved) {
      const width = Number(saved);
      if (
        Number.isFinite(width) &&
        width >= MIN_OUTLINE_WIDTH &&
        width <= MAX_OUTLINE_WIDTH
      ) {
        return width;
      }
    }
  } catch {}
  return DEFAULT_OUTLINE_WIDTH;
}

export function persistOutlineWidth(width: number): number {
  const nextWidth = clampOutlineWidth(width);
  try {
    localStorage.setItem(OUTLINE_WIDTH_STORAGE_KEY, String(nextWidth));
  } catch {}
  return nextWidth;
}
