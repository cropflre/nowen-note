import { copyText } from "@/lib/clipboard";

if (typeof Promise !== "undefined" && typeof Promise.allSettled !== "function") {
  Promise.allSettled = function allSettled<T>(
    values: Iterable<T | PromiseLike<T>>,
  ): Promise<PromiseSettledResult<Awaited<T>>[]> {
    return Promise.all(
      Array.from(values, (value) =>
        Promise.resolve(value).then(
          (result) => ({ status: "fulfilled", value: result }) as PromiseFulfilledResult<Awaited<T>>,
          (reason) => ({ status: "rejected", reason }) as PromiseRejectedResult,
        ),
      ),
    );
  };
}

if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
  crypto.randomUUID = function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

const EDITOR_SELECTOR =
  '.ProseMirror[contenteditable="true"], .cm-content[contenteditable="true"]';
const SELECTION_ACTIONS_ID = "nowen-android-selection-actions";
const SELECTION_STYLE_ID = "nowen-android-selection-style";
const INSTALL_KEY = "__NOWEN_ANDROID_EDITOR_SELECTION_COMPAT__" as const;
const COPY_ACTION_RE = /(?:复制.*(?:选中|选区|文本)|copy\s+(?:selected\s+text|selection))/i;

type CompatWindow = Window & typeof globalThis & {
  [INSTALL_KEY]?: () => void;
};

type SelectionRect = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

type EditorSelectionSnapshot = {
  root: HTMLElement;
  text: string;
  rect: SelectionRect;
};

export interface AndroidSelectionFallbackDecision {
  isAndroidNative: boolean;
  hasVisibleTextSelection: boolean;
  hasExistingCopyAction: boolean;
}

/**
 * The normal Tiptap / CodeMirror selection bubbles remain the primary UI. This
 * fallback is only needed when Android WebView keeps a DOM selection but drops
 * editor focus, which prevents the React bubble from being rendered.
 */
export function shouldShowAndroidSelectionFallback({
  isAndroidNative,
  hasVisibleTextSelection,
  hasExistingCopyAction,
}: AndroidSelectionFallbackDecision): boolean {
  return isAndroidNative && hasVisibleTextSelection && !hasExistingCopyAction;
}

function isAndroidNative(doc: Document): boolean {
  return doc.documentElement.getAttribute("data-native") === "android";
}

function findEditorRoot(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const element = node.nodeType === 1
    ? (node as Element)
    : node.parentElement;
  return element?.closest<HTMLElement>(EDITOR_SELECTOR) ?? null;
}

function readEditorSelection(doc: Document): EditorSelectionSnapshot | null {
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const anchorRoot = findEditorRoot(selection.anchorNode);
  const focusRoot = findEditorRoot(selection.focusNode);
  if (!anchorRoot || anchorRoot !== focusRoot) return null;

  const text = selection.toString();
  if (!text.trim()) return null;

  const range = selection.getRangeAt(0);
  const rects = Array.from(range.getClientRects());
  const sourceRect = rects[rects.length - 1] ?? range.getBoundingClientRect();

  return {
    root: anchorRoot,
    text,
    rect: {
      top: sourceRect.top,
      right: sourceRect.right,
      bottom: sourceRect.bottom,
      left: sourceRect.left,
      width: sourceRect.width || Math.max(0, sourceRect.right - sourceRect.left),
      height: sourceRect.height || Math.max(0, sourceRect.bottom - sourceRect.top),
    },
  };
}

function hasVisibleEditorCopyAction(doc: Document): boolean {
  const candidates = doc.querySelectorAll<HTMLElement>(
    'button[title], button[aria-label], [role="button"][aria-label]',
  );

  return Array.from(candidates).some((candidate) => {
    if (candidate.closest(`#${SELECTION_ACTIONS_ID}`)) return false;

    const label = [
      candidate.getAttribute("title"),
      candidate.getAttribute("aria-label"),
      candidate.textContent,
    ].filter(Boolean).join(" ");
    if (!COPY_ACTION_RE.test(label)) return false;

    const style = doc.defaultView?.getComputedStyle(candidate);
    if (style?.display === "none" || style?.visibility === "hidden") return false;

    const rect = candidate.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

function installSelectionStyles(doc: Document): void {
  if (doc.getElementById(SELECTION_STYLE_ID)) return;

  const style = doc.createElement("style");
  style.id = SELECTION_STYLE_ID;
  style.textContent = `
html[data-native="android"] .ProseMirror[contenteditable="true"],
html[data-native="android"] .cm-content[contenteditable="true"] {
  -webkit-user-select: text !important;
  user-select: text !important;
  -webkit-touch-callout: default !important;
}

#${SELECTION_ACTIONS_ID} {
  position: fixed;
  z-index: 90;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 10px;
  background: var(--color-elevated, #ffffff);
  color: var(--color-text-primary, #111827);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
  -webkit-user-select: none;
  user-select: none;
  touch-action: manipulation;
}

#${SELECTION_ACTIONS_ID}[hidden] {
  display: none !important;
}

#${SELECTION_ACTIONS_ID} button {
  min-width: 52px;
  min-height: 34px;
  padding: 6px 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  line-height: 1;
}

#${SELECTION_ACTIONS_ID} button:active {
  background: var(--color-hover, #f3f4f6);
}
`;
  doc.head.appendChild(style);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function positionSelectionActions(
  toolbar: HTMLElement,
  snapshot: EditorSelectionSnapshot,
  win: Window,
): void {
  toolbar.hidden = false;
  toolbar.style.visibility = "hidden";

  const toolbarRect = toolbar.getBoundingClientRect();
  const toolbarWidth = toolbarRect.width || 118;
  const toolbarHeight = toolbarRect.height || 42;
  const visualViewport = win.visualViewport;
  const viewportLeft = visualViewport?.offsetLeft ?? 0;
  const viewportTop = visualViewport?.offsetTop ?? 0;
  const viewportWidth = visualViewport?.width ?? win.innerWidth;
  const viewportHeight = visualViewport?.height ?? win.innerHeight;
  const viewportRight = viewportLeft + viewportWidth;
  const viewportBottom = viewportTop + viewportHeight;
  const selectionCenter = snapshot.rect.left + snapshot.rect.width / 2;

  let top = snapshot.rect.top - toolbarHeight - 10;
  if (!Number.isFinite(top) || top < viewportTop + 8) {
    top = snapshot.rect.bottom + 10;
  }
  top = clamp(top, viewportTop + 8, viewportBottom - toolbarHeight - 8);

  const left = clamp(
    selectionCenter - toolbarWidth / 2,
    viewportLeft + 8,
    viewportRight - toolbarWidth - 8,
  );

  toolbar.style.top = `${Math.round(top)}px`;
  toolbar.style.left = `${Math.round(left)}px`;
  toolbar.style.visibility = "visible";
}

/**
 * Android WebView occasionally leaves the native DOM selection alive while
 * temporarily blurring the contenteditable. Tiptap then closes its React bubble
 * because `view.hasFocus()` is false, and some WebView/input-method combinations
 * also fail to show Android ActionMode. Keep the native path enabled and provide
 * one small DOM-level Copy / Select all fallback when no editor copy action exists.
 */
export function installAndroidEditorSelectionCompat(): void {
  if (typeof window === "undefined" || typeof document === "undefined" || !document.body) return;

  const compatWindow = window as CompatWindow;
  if (compatWindow[INSTALL_KEY]) return;

  installSelectionStyles(document);

  let toolbar: HTMLDivElement | null = null;
  let copyButton: HTMLButtonElement | null = null;
  let latestSnapshot: EditorSelectionSnapshot | null = null;
  let frame = 0;
  let timer = 0;
  let feedbackTimer = 0;

  const hideToolbar = () => {
    latestSnapshot = null;
    if (toolbar) toolbar.hidden = true;
    if (copyButton) copyButton.textContent = "复制";
  };

  const ensureToolbar = (): HTMLDivElement => {
    if (toolbar) return toolbar;

    toolbar = document.createElement("div");
    toolbar.id = SELECTION_ACTIONS_ID;
    toolbar.hidden = true;
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "文本选择操作");

    const preserveSelection = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    toolbar.addEventListener("pointerdown", preserveSelection);
    toolbar.addEventListener("mousedown", preserveSelection);

    copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "复制";
    copyButton.setAttribute("aria-label", "复制选中文本");
    copyButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      const snapshot = latestSnapshot ?? readEditorSelection(document);
      if (!snapshot) {
        hideToolbar();
        return;
      }

      const copied = await copyText(snapshot.text);
      if (!copyButton) return;
      copyButton.textContent = copied ? "已复制" : "复制失败";
      window.clearTimeout(feedbackTimer);
      feedbackTimer = window.setTimeout(() => {
        if (copied) hideToolbar();
        else if (copyButton) copyButton.textContent = "复制";
      }, copied ? 700 : 1200);
    });

    const selectAllButton = document.createElement("button");
    selectAllButton.type = "button";
    selectAllButton.textContent = "全选";
    selectAllButton.setAttribute("aria-label", "全选编辑器文本");
    selectAllButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const snapshot = latestSnapshot ?? readEditorSelection(document);
      if (!snapshot) {
        hideToolbar();
        return;
      }

      const selection = document.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(snapshot.root);
      selection.removeAllRanges();
      selection.addRange(range);
      scheduleReconcile(0);
    });

    toolbar.append(copyButton, selectAllButton);
    document.body.appendChild(toolbar);
    return toolbar;
  };

  const reconcile = () => {
    timer = 0;
    const snapshot = readEditorSelection(document);
    const shouldShow = shouldShowAndroidSelectionFallback({
      isAndroidNative: isAndroidNative(document),
      hasVisibleTextSelection: !!snapshot,
      hasExistingCopyAction: hasVisibleEditorCopyAction(document),
    });

    if (!shouldShow || !snapshot) {
      hideToolbar();
      return;
    }

    latestSnapshot = snapshot;
    positionSelectionActions(ensureToolbar(), snapshot, window);
  };

  function scheduleReconcile(delay = 160): void {
    window.clearTimeout(timer);
    if (frame) window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      timer = window.setTimeout(reconcile, delay);
    });
  }

  const schedule = () => scheduleReconcile(toolbar && !toolbar.hidden ? 0 : 160);
  const onContextMenu = () => scheduleReconcile(80);

  document.addEventListener("selectionchange", schedule, true);
  document.addEventListener("pointerup", schedule, true);
  document.addEventListener("keyup", schedule, true);
  document.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule, { passive: true });
  window.visualViewport?.addEventListener("resize", schedule, { passive: true });

  compatWindow[INSTALL_KEY] = () => {
    window.clearTimeout(timer);
    window.clearTimeout(feedbackTimer);
    if (frame) window.cancelAnimationFrame(frame);
    document.removeEventListener("selectionchange", schedule, true);
    document.removeEventListener("pointerup", schedule, true);
    document.removeEventListener("keyup", schedule, true);
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("scroll", schedule, true);
    window.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("resize", schedule);
    toolbar?.remove();
    document.getElementById(SELECTION_STYLE_ID)?.remove();
    delete compatWindow[INSTALL_KEY];
  };
}

installAndroidEditorSelectionCompat();
