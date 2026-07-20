export interface SearchMatchRange {
  from: number;
  to: number;
}

export interface SearchMatchCoordinates {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface SearchMatchEditorView {
  dom: HTMLElement;
  coordsAtPos(position: number, side?: number): SearchMatchCoordinates;
}

export interface SearchMatchScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  containerTop: number;
  containerBottom: number;
  matchTop: number;
  matchBottom: number;
}

const SCROLLABLE_OVERFLOW_RE = /^(auto|scroll|overlay)$/;

export function findSearchScrollContainer(start: HTMLElement | null): HTMLElement | null {
  let current = start?.parentElement ?? null;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY || style.overflow;
    if (
      SCROLLABLE_OVERFLOW_RE.test(overflowY)
      && current.scrollHeight > current.clientHeight
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

export function calculateSearchMatchScrollTop({
  scrollTop,
  scrollHeight,
  clientHeight,
  containerTop,
  containerBottom,
  matchTop,
  matchBottom,
}: SearchMatchScrollMetrics): number {
  const viewportCenter = (containerTop + containerBottom) / 2;
  const matchCenter = (matchTop + matchBottom) / 2;
  const desired = scrollTop + matchCenter - viewportCenter;
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  return Math.max(0, Math.min(desired, maxScrollTop));
}

export function getSearchNavigationIndex(
  activeIndex: number,
  matchCount: number,
  direction: 1 | -1,
): number {
  if (matchCount <= 0) return -1;
  if (activeIndex < 0) return direction === 1 ? 0 : matchCount - 1;
  return (activeIndex + direction + matchCount) % matchCount;
}

export function isSearchNavigationUpdate(meta: Record<string, unknown>): boolean {
  const keys = Object.keys(meta);
  return keys.length === 1 && keys[0] === "activeIndex" && typeof meta.activeIndex === "number";
}

export function scrollSearchMatchIntoView({
  view,
  match,
  container = findSearchScrollContainer(view.dom),
  behavior = "auto",
}: {
  view: SearchMatchEditorView;
  match: SearchMatchRange;
  container?: HTMLElement | null;
  behavior?: ScrollBehavior;
}): number | null {
  if (!container) return null;

  let start: SearchMatchCoordinates;
  let end: SearchMatchCoordinates;
  try {
    start = view.coordsAtPos(match.from, 1);
    end = view.coordsAtPos(match.to, -1);
  } catch {
    return null;
  }

  const containerRect = container.getBoundingClientRect();
  const top = calculateSearchMatchScrollTop({
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    containerTop: containerRect.top,
    containerBottom: containerRect.bottom,
    matchTop: Math.min(start.top, end.top),
    matchBottom: Math.max(start.bottom, end.bottom),
  });

  container.scrollTo({ top, behavior });
  return top;
}
