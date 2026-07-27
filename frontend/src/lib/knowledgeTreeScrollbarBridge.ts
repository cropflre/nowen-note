const TREE_SCROLL_SELECTOR =
  '[data-sidebar-variant="desktop"] [data-swipe-blocker="knowledge-tree-scroll"]';
const STYLE_ID = "nowen-knowledge-tree-custom-scrollbar-style";
const SCROLL_CLASS = "nowen-knowledge-tree-custom-scroll-host";
const PARENT_CLASS = "nowen-knowledge-tree-custom-scroll-parent";
const TRACK_CLASS = "nowen-knowledge-tree-custom-scroll-track";
const THUMB_CLASS = "nowen-knowledge-tree-custom-scroll-thumb";
const MIN_THUMB_HEIGHT = 36;

export interface KnowledgeTreeScrollbarMetricsInput {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  trackHeight?: number;
  minThumbHeight?: number;
}

export interface KnowledgeTreeScrollbarMetrics {
  visible: boolean;
  thumbHeight: number;
  thumbTop: number;
  maxScrollTop: number;
  maxThumbTop: number;
}

/** Pure geometry helper shared by runtime code and regression tests. */
export function calculateKnowledgeTreeScrollbarMetrics({
  scrollTop,
  scrollHeight,
  clientHeight,
  trackHeight = clientHeight,
  minThumbHeight = MIN_THUMB_HEIGHT,
}: KnowledgeTreeScrollbarMetricsInput): KnowledgeTreeScrollbarMetrics {
  const safeClientHeight = Math.max(0, clientHeight);
  const safeScrollHeight = Math.max(safeClientHeight, scrollHeight);
  const safeTrackHeight = Math.max(0, trackHeight);
  const maxScrollTop = Math.max(0, safeScrollHeight - safeClientHeight);
  const visible = safeClientHeight > 0 && maxScrollTop > 1 && safeTrackHeight > 0;

  if (!visible) {
    return {
      visible: false,
      thumbHeight: safeTrackHeight,
      thumbTop: 0,
      maxScrollTop,
      maxThumbTop: 0,
    };
  }

  const proportionalHeight = safeTrackHeight * (safeClientHeight / safeScrollHeight);
  const thumbHeight = Math.min(
    safeTrackHeight,
    Math.max(Math.min(minThumbHeight, safeTrackHeight), proportionalHeight),
  );
  const maxThumbTop = Math.max(0, safeTrackHeight - thumbHeight);
  const clampedScrollTop = Math.min(maxScrollTop, Math.max(0, scrollTop));
  const thumbTop = maxScrollTop > 0
    ? (clampedScrollTop / maxScrollTop) * maxThumbTop
    : 0;

  return {
    visible: true,
    thumbHeight,
    thumbTop,
    maxScrollTop,
    maxThumbTop,
  };
}

function ensureScrollbarStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.${PARENT_CLASS} {
  position: relative !important;
}

html body .${SCROLL_CLASS} {
  scrollbar-width: none !important;
  -ms-overflow-style: none !important;
  padding-right: 10px;
}

html body .${SCROLL_CLASS}::-webkit-scrollbar {
  width: 0 !important;
  height: 0 !important;
  display: none !important;
}

.${TRACK_CLASS} {
  position: absolute;
  right: 2px;
  z-index: 35;
  width: 9px;
  border-radius: 999px;
  background: transparent;
  cursor: default;
  touch-action: none;
  user-select: none;
  transition: background-color 140ms ease;
}

.${TRACK_CLASS}:hover,
.${TRACK_CLASS}:focus-visible,
.${TRACK_CLASS}[data-dragging="true"] {
  background: color-mix(in srgb, var(--pm-scrollbar) 12%, transparent);
  outline: none;
}

.${THUMB_CLASS} {
  position: absolute;
  left: 2.5px;
  right: 2.5px;
  top: 0;
  min-height: ${MIN_THUMB_HEIGHT}px;
  border-radius: 999px;
  background: var(--pm-scrollbar);
  cursor: grab;
  opacity: 0.58;
  transition: left 140ms ease, right 140ms ease, background-color 120ms ease, opacity 120ms ease;
  will-change: transform, height;
}

.${TRACK_CLASS}:hover .${THUMB_CLASS},
.${TRACK_CLASS}:focus-visible .${THUMB_CLASS},
.${TRACK_CLASS}[data-dragging="true"] .${THUMB_CLASS} {
  left: 1.5px;
  right: 1.5px;
  background: var(--pm-scrollbar-hover);
  opacity: 0.95;
}

.${TRACK_CLASS}[data-dragging="true"] .${THUMB_CLASS} {
  cursor: grabbing;
}

.${TRACK_CLASS}[data-scrollable="false"] .${THUMB_CLASS} {
  cursor: default;
  opacity: 0;
  pointer-events: none;
}

.${TRACK_CLASS}[data-scrollable="false"]:hover,
.${TRACK_CLASS}[data-scrollable="false"]:focus-visible {
  background: transparent;
}

@media (max-width: 767px) {
  .${TRACK_CLASS} {
    display: none !important;
  }
  html body .${SCROLL_CLASS} {
    padding-right: 0;
  }
}
`;
  document.head.appendChild(style);
}

interface ScrollController {
  destroy: () => void;
  isConnected: () => boolean;
  update: () => void;
}

const controllers = new Map<HTMLElement, ScrollController>();
let installed = false;
let reconcileFrame = 0;
let generatedId = 0;

function attachScrollbar(scrollElement: HTMLElement): ScrollController | null {
  const parent = scrollElement.parentElement;
  if (!parent) return null;

  scrollElement.classList.add(SCROLL_CLASS);
  parent.classList.add(PARENT_CLASS);
  if (!scrollElement.id) {
    generatedId += 1;
    scrollElement.id = `nowen-knowledge-tree-scroll-${generatedId}`;
  }

  const track = document.createElement("div");
  track.className = TRACK_CLASS;
  track.tabIndex = 0;
  track.setAttribute("role", "scrollbar");
  track.setAttribute("aria-orientation", "vertical");
  track.setAttribute("aria-label", "内容树滚动条");
  track.setAttribute("aria-controls", scrollElement.id);

  const thumb = document.createElement("div");
  thumb.className = THUMB_CLASS;
  track.appendChild(thumb);
  parent.appendChild(track);

  let disposed = false;
  let updateFrame = 0;
  let latestMetrics = calculateKnowledgeTreeScrollbarMetrics({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  });
  let dragState: {
    pointerId: number;
    startY: number;
    startScrollTop: number;
  } | null = null;

  const update = () => {
    if (disposed) return;
    const trackHeight = scrollElement.clientHeight;
    latestMetrics = calculateKnowledgeTreeScrollbarMetrics({
      scrollTop: scrollElement.scrollTop,
      scrollHeight: scrollElement.scrollHeight,
      clientHeight: scrollElement.clientHeight,
      trackHeight,
    });

    track.hidden = trackHeight <= 0;
    track.dataset.scrollable = String(latestMetrics.visible);
    track.setAttribute("aria-disabled", String(!latestMetrics.visible));
    track.style.top = `${scrollElement.offsetTop}px`;
    track.style.height = `${trackHeight}px`;
    thumb.style.height = `${latestMetrics.thumbHeight}px`;
    thumb.style.transform = `translateY(${latestMetrics.thumbTop}px)`;
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(Math.round(latestMetrics.maxScrollTop)));
    track.setAttribute("aria-valuenow", String(Math.round(scrollElement.scrollTop)));
  };

  const scheduleUpdate = () => {
    if (disposed || updateFrame) return;
    updateFrame = window.requestAnimationFrame(() => {
      updateFrame = 0;
      update();
    });
  };

  const scrollToTrackPointer = (clientY: number) => {
    const rect = track.getBoundingClientRect();
    const targetThumbTop = clientY - rect.top - latestMetrics.thumbHeight / 2;
    const clampedThumbTop = Math.min(
      latestMetrics.maxThumbTop,
      Math.max(0, targetThumbTop),
    );
    scrollElement.scrollTop = latestMetrics.maxThumbTop > 0
      ? (clampedThumbTop / latestMetrics.maxThumbTop) * latestMetrics.maxScrollTop
      : 0;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!latestMetrics.visible || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    track.focus({ preventScroll: true });

    if (event.target !== thumb) {
      scrollToTrackPointer(event.clientY);
      scheduleUpdate();
    }

    dragState = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: scrollElement.scrollTop,
    };
    track.dataset.dragging = "true";
    track.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const scrollPerThumbPixel = latestMetrics.maxThumbTop > 0
      ? latestMetrics.maxScrollTop / latestMetrics.maxThumbTop
      : 0;
    scrollElement.scrollTop = dragState.startScrollTop
      + (event.clientY - dragState.startY) * scrollPerThumbPixel;
  };

  const finishPointerDrag = (event: PointerEvent) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    dragState = null;
    delete track.dataset.dragging;
    if (track.hasPointerCapture?.(event.pointerId)) {
      track.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    let nextScrollTop: number | null = null;
    const page = Math.max(40, scrollElement.clientHeight * 0.85);
    if (event.key === "ArrowDown") nextScrollTop = scrollElement.scrollTop + 40;
    else if (event.key === "ArrowUp") nextScrollTop = scrollElement.scrollTop - 40;
    else if (event.key === "PageDown") nextScrollTop = scrollElement.scrollTop + page;
    else if (event.key === "PageUp") nextScrollTop = scrollElement.scrollTop - page;
    else if (event.key === "Home") nextScrollTop = 0;
    else if (event.key === "End") nextScrollTop = latestMetrics.maxScrollTop;
    if (nextScrollTop == null) return;
    event.preventDefault();
    scrollElement.scrollTo({ top: nextScrollTop, behavior: "smooth" });
  };

  scrollElement.addEventListener("scroll", scheduleUpdate, { passive: true });
  track.addEventListener("pointerdown", onPointerDown);
  track.addEventListener("pointermove", onPointerMove);
  track.addEventListener("pointerup", finishPointerDrag);
  track.addEventListener("pointercancel", finishPointerDrag);
  track.addEventListener("keydown", onKeyDown);

  const ResizeObserverCtor = window.ResizeObserver;
  const resizeObserver = ResizeObserverCtor
    ? new ResizeObserverCtor(scheduleUpdate)
    : null;
  resizeObserver?.observe(scrollElement);
  resizeObserver?.observe(parent);

  const contentObserver = new MutationObserver(scheduleUpdate);
  contentObserver.observe(scrollElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });

  const parentObserver = new MutationObserver(() => {
    if (!track.isConnected) refreshKnowledgeTreeScrollbars();
  });
  parentObserver.observe(parent, { childList: true });

  update();

  return {
    isConnected: () => track.isConnected,
    update: scheduleUpdate,
    destroy: () => {
      if (disposed) return;
      disposed = true;
      if (updateFrame) window.cancelAnimationFrame(updateFrame);
      resizeObserver?.disconnect();
      contentObserver.disconnect();
      parentObserver.disconnect();
      scrollElement.removeEventListener("scroll", scheduleUpdate);
      track.removeEventListener("pointerdown", onPointerDown);
      track.removeEventListener("pointermove", onPointerMove);
      track.removeEventListener("pointerup", finishPointerDrag);
      track.removeEventListener("pointercancel", finishPointerDrag);
      track.removeEventListener("keydown", onKeyDown);
      scrollElement.classList.remove(SCROLL_CLASS);
      track.remove();
      if (!parent.querySelector(`.${TRACK_CLASS}`)) {
        parent.classList.remove(PARENT_CLASS);
      }
    },
  };
}

function reconcileScrollbars(): void {
  for (const [element, controller] of controllers) {
    if (
      !element.isConnected
      || !element.matches(TREE_SCROLL_SELECTOR)
      || !controller.isConnected()
    ) {
      controller.destroy();
      controllers.delete(element);
    }
  }

  document.querySelectorAll<HTMLElement>(TREE_SCROLL_SELECTOR).forEach((element) => {
    if (controllers.has(element)) return;
    const controller = attachScrollbar(element);
    if (controller) controllers.set(element, controller);
  });
}

function scheduleReconcile(): void {
  if (reconcileFrame) return;
  reconcileFrame = window.requestAnimationFrame(() => {
    reconcileFrame = 0;
    reconcileScrollbars();
    controllers.forEach((controller) => controller.update());
  });
}

/** 桌面侧栏挂载、卸载或轨道丢失时，显式协调树滚动条。 */
export function refreshKnowledgeTreeScrollbars(): void {
  if (!installed) return;
  scheduleReconcile();
}

/**
 * Installs an OS-independent scrollbar for the desktop knowledge tree.
 * Native overlay scrollbars can remain invisible in Chrome/Web regardless of
 * CSS, so this bridge renders and synchronizes its own draggable thumb.
 */
export function installKnowledgeTreeScrollbarBridge(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  if (installed) return () => {};
  installed = true;
  ensureScrollbarStyles();

  const start = () => {
    scheduleReconcile();
    window.addEventListener("resize", scheduleReconcile, { passive: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  return () => {
    document.removeEventListener("DOMContentLoaded", start);
    window.removeEventListener("resize", scheduleReconcile);
    if (reconcileFrame) window.cancelAnimationFrame(reconcileFrame);
    reconcileFrame = 0;
    controllers.forEach((controller) => controller.destroy());
    controllers.clear();
    installed = false;
  };
}
