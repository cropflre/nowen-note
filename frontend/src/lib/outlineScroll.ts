export const OUTLINE_SCROLL_RESERVE_PROPERTY = "--outline-scroll-reserve";
export const DEFAULT_OUTLINE_SCROLL_GAP = 24;

export interface OutlineScrollMetrics {
  scrollTop: number;
  containerTop: number;
  targetTop: number;
  scrollHeight: number;
  clientHeight: number;
  topOffset?: number;
  gap?: number;
}

export interface OutlineReserveMetrics {
  desiredScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  currentReserve?: number;
}

export function calculateOutlineDesiredScrollTop({
  scrollTop,
  containerTop,
  targetTop,
  topOffset = 0,
  gap = DEFAULT_OUTLINE_SCROLL_GAP,
}: Omit<OutlineScrollMetrics, "scrollHeight" | "clientHeight">): number {
  return scrollTop
    + targetTop
    - containerTop
    - Math.max(0, topOffset)
    - Math.max(0, gap);
}

export function calculateOutlineScrollTop(metrics: OutlineScrollMetrics): number {
  const desired = calculateOutlineDesiredScrollTop(metrics);
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  return Math.max(0, Math.min(desired, maxScrollTop));
}

/**
 * Return the minimum extra bottom padding needed to make the desired heading position
 * reachable. `scrollHeight` already contains `currentReserve`, so subtract it before
 * calculating the natural maximum scroll position.
 */
export function calculateRequiredOutlineReserve({
  desiredScrollTop,
  scrollHeight,
  clientHeight,
  currentReserve = 0,
}: OutlineReserveMetrics): number {
  const safeCurrentReserve = Math.max(0, currentReserve);
  const naturalScrollHeight = Math.max(0, scrollHeight - safeCurrentReserve);
  const naturalMaxScrollTop = Math.max(0, naturalScrollHeight - clientHeight);
  const required = Math.max(0, desiredScrollTop - naturalMaxScrollTop);
  return Math.max(safeCurrentReserve, Math.ceil(required));
}

function readCurrentReserve(container: HTMLElement): number {
  const raw = container.style.getPropertyValue(OUTLINE_SCROLL_RESERVE_PROPERTY);
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function calculateTopOverlayOverlap(
  containerRect: DOMRect,
  overlay: HTMLElement | null | undefined,
): number {
  if (!overlay) return 0;
  const overlayRect = overlay.getBoundingClientRect();
  // Only count an element that actually covers the scroll viewport's top edge.
  // A toolbar ending immediately above the viewport remains normal-flow content and
  // must not be subtracted a second time.
  if (overlayRect.top > containerRect.top + 1 || overlayRect.bottom <= containerRect.top) {
    return 0;
  }
  return Math.max(0, Math.min(containerRect.bottom, overlayRect.bottom) - containerRect.top);
}

export function clearOutlineScrollReserve(container: HTMLElement | null | undefined): void {
  container?.style.removeProperty(OUTLINE_SCROLL_RESERVE_PROPERTY);
}

export interface ScrollOutlineTargetOptions {
  container: HTMLElement;
  target: HTMLElement;
  topOverlay?: HTMLElement | null;
  gap?: number;
  behavior?: ScrollBehavior;
}

/**
 * Scroll a heading to one deterministic top anchor inside its real scroll container.
 *
 * Unlike Element.scrollIntoView(), this never delegates alignment to the browser's
 * nearest-edge heuristics. It also adds only the bottom reserve that is actually needed,
 * allowing the last heading to reach the same anchor as headings in the middle.
 */
export function scrollOutlineTargetIntoView({
  container,
  target,
  topOverlay = null,
  gap = DEFAULT_OUTLINE_SCROLL_GAP,
  behavior = "smooth",
}: ScrollOutlineTargetOptions): number {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const topOffset = calculateTopOverlayOverlap(containerRect, topOverlay);
  const desiredScrollTop = calculateOutlineDesiredScrollTop({
    scrollTop: container.scrollTop,
    containerTop: containerRect.top,
    targetTop: targetRect.top,
    topOffset,
    gap,
  });

  const currentReserve = readCurrentReserve(container);
  const requiredReserve = calculateRequiredOutlineReserve({
    desiredScrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    currentReserve,
  });

  if (requiredReserve > currentReserve) {
    container.style.setProperty(
      OUTLINE_SCROLL_RESERVE_PROPERTY,
      `${requiredReserve}px`,
    );
  }

  // Reading scrollHeight after updating the CSS custom property forces the browser to
  // include the new padding before the final, single scroll operation.
  const top = calculateOutlineScrollTop({
    scrollTop: container.scrollTop,
    containerTop: containerRect.top,
    targetTop: targetRect.top,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    topOffset,
    gap,
  });

  container.scrollTo({ top, behavior });
  return top;
}
