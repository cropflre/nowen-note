const INSTALL_KEY = Symbol.for("nowen.inline-comment-tooltip-mount");
const PROXY_ATTR = "data-inline-comment-tooltip-proxy";
const FALLBACK_ATTR = "data-inline-comment-tooltip-fallback";
const STYLE_ID = "nowen-inline-comment-tooltip-style";

const PROXY_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true">
  <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
  <path d="M12 7v6" />
  <path d="M9 10h6" />
</svg>`;

function installStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* InlineCommentBridge still owns the action and selection anchor. Hide its
       old standalone trigger before the DOM mount bridge places a proxy in the
       editor's existing selection tooltip. Visibility keeps its geometry so
       the fallback tooltip can use the same position without a visual flash. */
    button[data-inline-comment-ui]:has(svg.lucide-message-square-plus) {
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `;
  document.head.appendChild(style);
}

function findSelectionTrigger(): HTMLButtonElement | null {
  const buttons = document.querySelectorAll<HTMLButtonElement>("button[data-inline-comment-ui]");
  for (const button of buttons) {
    if (button.querySelector("svg.lucide-message-square-plus")) return button;
  }
  return null;
}

function isVisibleElement(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0;
}

function axisGap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  if (aEnd < bStart) return bStart - aEnd;
  if (bEnd < aStart) return aStart - bEnd;
  return 0;
}

function rectDistance(a: DOMRect, b: DOMRect): { horizontal: number; vertical: number } {
  return {
    horizontal: axisGap(a.left, a.right, b.left, b.right),
    vertical: axisGap(a.top, a.bottom, b.top, b.bottom),
  };
}

function visibleButtonsWithin(element: HTMLElement): HTMLButtonElement[] {
  return Array.from(element.querySelectorAll<HTMLButtonElement>("button")).filter((button) => {
    if (button.hasAttribute(PROXY_ATTR)) return false;
    return isVisibleElement(button);
  });
}

function isCandidateToolbar(
  element: HTMLElement,
  original: HTMLButtonElement,
  originalRect: DOMRect,
): boolean {
  if (element === document.body || element === document.documentElement) return false;
  if (element.contains(original)) return false;
  if (element.hasAttribute(FALLBACK_ATTR) || element.closest(`[${FALLBACK_ATTR}]`)) return false;
  if (element.closest("[role='dialog'], [aria-modal='true']")) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width < 96 || rect.height < 28 || rect.height > 112) return false;
  if (rect.right < 0 || rect.left > window.innerWidth || rect.bottom < 0 || rect.top > window.innerHeight) return false;

  const position = getComputedStyle(element).position;
  if (position !== "fixed" && position !== "absolute") return false;

  const buttons = visibleButtonsWithin(element);
  if (buttons.length < 3) return false;
  if (element.querySelector("textarea, input[type='text'], [contenteditable='true']")) return false;

  const distance = rectDistance(rect, originalRect);
  const centerDelta = Math.abs((rect.top + rect.bottom) / 2 - (originalRect.top + originalRect.bottom) / 2);
  const nearSelection = distance.horizontal <= 190 && distance.vertical <= 110 && centerDelta <= 130;
  const mobileBottomToolbar = window.innerWidth < 768 && rect.bottom >= window.innerHeight - 180;
  return nearSelection || mobileBottomToolbar;
}

function candidateScore(element: HTMLElement, originalRect: DOMRect): number {
  const rect = element.getBoundingClientRect();
  const distance = rectDistance(rect, originalRect);
  const centerDelta = Math.abs((rect.top + rect.bottom) / 2 - (originalRect.top + originalRect.bottom) / 2);
  const areaPenalty = (rect.width * rect.height) / 5000;
  return distance.horizontal * 2 + distance.vertical * 4 + centerDelta * 1.5 + areaPenalty;
}

function findSelectionToolbar(
  original: HTMLButtonElement,
  originalRect: DOMRect,
  retainedToolbar: HTMLElement | null,
): HTMLElement | null {
  if (
    retainedToolbar?.isConnected
    && !retainedToolbar.hasAttribute(FALLBACK_ATTR)
    && isCandidateToolbar(retainedToolbar, original, originalRect)
  ) {
    return retainedToolbar;
  }

  const candidates = new Set<HTMLElement>();
  const allButtons = document.querySelectorAll<HTMLButtonElement>("button");
  for (const button of allButtons) {
    if (button === original || button.hasAttribute(PROXY_ATTR) || !isVisibleElement(button)) continue;
    const buttonRect = button.getBoundingClientRect();
    const distance = rectDistance(buttonRect, originalRect);
    const isNearby = distance.horizontal <= 230 && distance.vertical <= 150;
    const isMobileBottom = window.innerWidth < 768 && buttonRect.bottom >= window.innerHeight - 180;
    if (!isNearby && !isMobileBottom) continue;

    let ancestor = button.parentElement;
    for (let depth = 0; ancestor && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
      if (isCandidateToolbar(ancestor, original, originalRect)) candidates.add(ancestor);
    }
  }

  return Array.from(candidates).sort(
    (a, b) => candidateScore(a, originalRect) - candidateScore(b, originalRect),
  )[0] || null;
}

function createProxyButton(
  original: HTMLButtonElement,
  referenceButton: HTMLButtonElement | null,
): HTMLButtonElement {
  const proxy = document.createElement("button");
  proxy.type = "button";
  proxy.setAttribute(PROXY_ATTR, "true");
  proxy.className = referenceButton?.className
    || "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-accent-primary transition-colors hover:bg-app-hover";
  proxy.style.flexShrink = "0";
  proxy.innerHTML = PROXY_ICON;

  const updateLabel = () => {
    const label = original.getAttribute("aria-label") || original.title || "添加批注";
    proxy.title = label;
    proxy.setAttribute("aria-label", label);
  };
  updateLabel();

  const preserveSelection = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  proxy.addEventListener("pointerdown", preserveSelection);
  proxy.addEventListener("mousedown", preserveSelection);
  proxy.addEventListener("click", (event) => {
    preserveSelection(event);
    if (original.isConnected) original.click();
  });
  return proxy;
}

function createFallbackTooltip(original: HTMLButtonElement): {
  shell: HTMLDivElement;
  proxy: HTMLButtonElement;
} {
  const shell = document.createElement("div");
  shell.setAttribute(FALLBACK_ATTR, "true");
  shell.setAttribute("data-inline-comment-ui", "true");
  shell.className = "fixed z-[88] flex items-center rounded-lg border border-app-border bg-app-elevated p-1 shadow-lg";

  const proxy = createProxyButton(original, null);
  shell.appendChild(proxy);
  document.body.appendChild(shell);
  return { shell, proxy };
}

function positionFallback(shell: HTMLElement, originalRect: DOMRect): void {
  const width = Math.max(42, shell.getBoundingClientRect().width || 42);
  const height = Math.max(42, shell.getBoundingClientRect().height || 42);
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, originalRect.left));
  const top = Math.max(8, Math.min(window.innerHeight - height - 8, originalRect.top));
  shell.style.left = `${left}px`;
  shell.style.top = `${top}px`;
}

function mutationContainsTrigger(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  if (node.matches("button[data-inline-comment-ui]")) {
    return !!node.querySelector("svg.lucide-message-square-plus");
  }
  return !!node.querySelector("button[data-inline-comment-ui] svg.lucide-message-square-plus");
}

/**
 * Moves the inline-comment action into the existing Tiptap / CodeMirror
 * selection tooltip without coupling InlineCommentBridge to either editor.
 *
 * InlineCommentBridge remains the source of truth for selection anchors,
 * permissions and panel state. This installer only mirrors its hidden trigger
 * into the visible selection toolbar and forwards the click back to React.
 */
export function installInlineCommentTooltipMount(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const runtime = window as any;
  if (runtime[INSTALL_KEY]) return;
  runtime[INSTALL_KEY] = true;
  installStyle();

  let frame = 0;
  let misses = 0;
  let currentOriginal: HTMLButtonElement | null = null;
  let currentToolbar: HTMLElement | null = null;
  let currentProxy: HTMLButtonElement | null = null;
  let fallbackShell: HTMLDivElement | null = null;

  const clearMount = () => {
    currentProxy?.remove();
    fallbackShell?.remove();
    currentProxy = null;
    fallbackShell = null;
    currentToolbar = null;
  };

  const mountInToolbar = (
    original: HTMLButtonElement,
    toolbar: HTMLElement,
  ) => {
    clearMount();
    const reference = visibleButtonsWithin(toolbar)[0] || null;
    currentProxy = createProxyButton(original, reference);
    toolbar.appendChild(currentProxy);
    currentToolbar = toolbar;
  };

  const mountFallback = (original: HTMLButtonElement, originalRect: DOMRect) => {
    clearMount();
    const fallback = createFallbackTooltip(original);
    fallbackShell = fallback.shell;
    currentProxy = fallback.proxy;
    currentToolbar = fallback.shell;
    positionFallback(fallback.shell, originalRect);
  };

  const sync = () => {
    frame = 0;
    const original = findSelectionTrigger();
    if (!original) {
      currentOriginal = null;
      misses = 0;
      clearMount();
      return;
    }

    original.style.setProperty("visibility", "hidden", "important");
    original.style.setProperty("pointer-events", "none", "important");
    const originalRect = original.getBoundingClientRect();
    if (originalRect.width < 1 || originalRect.height < 1) {
      clearMount();
      return;
    }

    const toolbar = findSelectionToolbar(original, originalRect, currentToolbar);
    if (toolbar) {
      misses = 0;
      if (
        original !== currentOriginal
        || toolbar !== currentToolbar
        || !currentProxy?.isConnected
        || !!fallbackShell
      ) {
        mountInToolbar(original, toolbar);
      }
      currentOriginal = original;
      return;
    }

    misses += 1;
    currentOriginal = original;
    if (misses < 2) {
      schedule();
      return;
    }
    if (!fallbackShell?.isConnected || !currentProxy?.isConnected) {
      mountFallback(original, originalRect);
    } else {
      positionFallback(fallbackShell, originalRect);
    }
  };

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(sync);
  };

  const observer = new MutationObserver((records) => {
    if (currentOriginal) {
      schedule();
      return;
    }
    for (const record of records) {
      if (mutationContainsTrigger(record.target)) {
        schedule();
        return;
      }
      for (const node of record.addedNodes) {
        if (mutationContainsTrigger(node)) {
          schedule();
          return;
        }
      }
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "title", "aria-label"],
  });

  document.addEventListener("selectionchange", schedule, true);
  document.addEventListener("mouseup", schedule, true);
  document.addEventListener("keyup", schedule, true);
  document.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  schedule();
}
