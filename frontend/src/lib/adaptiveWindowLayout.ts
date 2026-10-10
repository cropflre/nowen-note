export type AdaptiveWindowClass = "compact" | "medium" | "expanded";

export const MEDIUM_WINDOW_MIN_WIDTH = 600;
export const EXPANDED_WINDOW_MIN_WIDTH = 840;
export const COMPACT_WINDOW_MAX_HEIGHT = 480;
export const MEDIUM_NOTE_LIST_MIN_WIDTH = 264;
export const MEDIUM_NOTE_LIST_MAX_WIDTH = 320;
export const MEDIUM_NOTE_LIST_WIDTH_RATIO = 0.42;

export function resolveAdaptiveWindowClass(
  width: number,
  height: number,
): AdaptiveWindowClass {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return "compact";
  if (width < MEDIUM_WINDOW_MIN_WIDTH || height < COMPACT_WINDOW_MAX_HEIGHT) return "compact";
  if (width < EXPANDED_WINDOW_MIN_WIDTH) return "medium";
  return "expanded";
}
export function resolveMediumNoteListWidth(viewportWidth: number): number {
  const proportionalWidth = Math.round(viewportWidth * MEDIUM_NOTE_LIST_WIDTH_RATIO);
  return Math.min(
    MEDIUM_NOTE_LIST_MAX_WIDTH,
    Math.max(MEDIUM_NOTE_LIST_MIN_WIDTH, proportionalWidth),
  );
}
