import React, { useEffect, useLayoutEffect, useRef } from "react";
import KnowledgeTreeDrawer from "@/components/KnowledgeTreeDrawer";
import ShortcutHelpCenter from "@/components/ShortcutHelpCenter";
import ShortcutRuntimeBridge from "@/components/ShortcutRuntimeBridge";
import { useApp, useAppActions } from "@/store/AppContext";
import { usesFunctionalNoteList } from "@/lib/unifiedTreeOnlyLayout";

export const MOBILE_DRAWER_SEARCH_BLUR_DELAY_MS = 160;
export const MOBILE_NOTE_CARD_TOUCH_RELEASE_DELAY_MS = 240;

export function isMobileDrawerViewport(width: number): boolean {
  return Number.isFinite(width) && width < 768;
}

export function getSidebarSearchInput(target: EventTarget | null): HTMLInputElement | null {
  if (!(target instanceof HTMLInputElement)) return null;
  return target.matches("[data-sidebar-search]") ? target : null;
}

export function shouldCloseDrawerOnSearchEnter(
  event: Pick<KeyboardEvent, "key" | "isComposing" | "keyCode">,
  value: string,
): boolean {
  return event.key === "Enter"
    && !event.isComposing
    && event.keyCode !== 229
    && value.trim().length > 0;
}

export function shouldCloseDrawerAfterSearchBlur(
  value: string,
  input: HTMLInputElement,
  activeElement: Element | null,
): boolean {
  return value.trim().length > 0 && activeElement !== input;
}

/**
 * Resolve the rendered note card from any title/preview/meta descendant.
 *
 * NoteCard intentionally has no extra runtime state. Its existing `group` root plus the
 * stable `.note-card-title` marker is enough to identify the card without coupling this
 * touch guard to NoteList's large render tree.
 */
export function getNoteCardSelectionRoot(target: EventTarget | null): HTMLElement | null {
  let cursor: Element | null = null;
  if (target instanceof Element) {
    cursor = target;
  } else if (typeof Node !== "undefined" && target instanceof Node) {
    cursor = target.parentElement;
  }

  while (cursor) {
    if (
      cursor instanceof HTMLElement
      && cursor.classList.contains("group")
      && cursor.querySelector(".note-card-title")
    ) {
      return cursor;
    }
    cursor = cursor.parentElement;
  }
  return null;
}

export function shouldSuppressNoteCardSelection(
  target: EventTarget | null,
  activeTouchCard: HTMLElement | null,
): boolean {
  if (!activeTouchCard) return false;
  return getNoteCardSelectionRoot(target) === activeTouchCard;
}

function findMobileRailRoot(button: HTMLButtonElement): HTMLElement | null {
  let cursor: HTMLElement | null = button.parentElement;
  while (cursor) {
    if (
      cursor.classList.contains("md:hidden")
      && cursor.classList.contains("h-full")
      && cursor.querySelector("button") === button
    ) {
      return cursor;
    }
    cursor = cursor.parentElement;
  }
  return null;
}

/**
 * Existing mobile headers live in several large components. Annotating the actual rendered
 * controls keeps the safe-area fix in one place and also covers future views that use a Menu
 * icon to open the same drawer.
 */
export function annotateMobileDrawerControls(root: ParentNode = document): void {
  root.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    if (button.querySelector("svg.lucide-menu")) {
      button.setAttribute("data-mobile-drawer-trigger", "");
      button.closest("header")?.setAttribute("data-mobile-safe-topbar", "");
    }

    if (!button.querySelector("svg.lucide-x")) return;
    const railRoot = findMobileRailRoot(button);
    if (!railRoot) return;
    railRoot.setAttribute("data-mobile-drawer-rail", "");
    button.setAttribute("data-mobile-drawer-close", "");
  });
}

export const ANDROID_DRAWER_SAFE_AREA_CSS = `
@media (max-width: 767px) {
  html[data-native="android"] [data-mobile-safe-topbar] {
    padding-top: max(calc(var(--safe-area-top) + 8px), 44px) !important;
  }

  html[data-native="android"] [data-mobile-drawer-trigger],
  html[data-native="android"] [data-mobile-drawer-close] {
    min-width: 44px !important;
    min-height: 44px !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }

  html[data-native="android"] [data-mobile-drawer-rail] {
    padding-top: max(calc(var(--safe-area-top) + 8px), 44px) !important;
  }

  /* Android WebView may enlarge tiny CJK text and clip it against the 64px label rail.
     Give label mode a little more room and use a non-clipping line box. Icon mode keeps
     its compact width, so switching modes still behaves as expected. */
  html[data-native="android"] [data-mobile-drawer-rail].w-16 {
    width: 72px !important;
    min-width: 72px !important;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
  }

  html[data-native="android"] [data-mobile-drawer-rail].w-16 [data-mobile-drawer-rail-item] {
    width: 64px !important;
    max-width: 64px !important;
  }

  html[data-native="android"] [data-mobile-drawer-rail].w-16 [data-mobile-drawer-rail-item] > span:last-child {
    max-width: 64px !important;
    padding-left: 2px !important;
    padding-right: 2px !important;
    line-height: 1.35 !important;
    white-space: nowrap !important;
    overflow: visible !important;
    text-overflow: clip !important;
  }
}
`;

const LEGACY_NOTE_LIST_CONTROL_CSS = `
/* The canonical standard/three-column/focus selector lives in the knowledge-tree
   header. Hide older direct expand/collapse controls so two independent layout
   controls cannot compete for the same panel state. */
button[title="展开笔记列表"],
button[title="收起笔记列表"],
button[aria-label="展开笔记列表"],
button[aria-label="收起笔记列表"],
button[title="Expand note list"],
button[title="Collapse note list"],
button[aria-label="Expand note list"],
button[aria-label="Collapse note list"] {
  display: none !important;
}
`;

export default function MobileDrawerUxBridge() {
  const { state } = useApp();
  const actions = useAppActions();
  const mobileSidebarOpenRef = useRef(state.mobileSidebarOpen);
  const blurTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mobileSidebarOpenRef.current = state.mobileSidebarOpen;
  }, [state.mobileSidebarOpen]);

  /**
   * This bridge owns progressive mobile navigation only. Wide Web/Electron
   * note-list visibility is owned exclusively by NoteWorkspaceLayoutController.
   *
   * The previous implementation also forced noteListCollapsed for every view.
   * That legacy rule immediately undid a user's three-column selection, making
   * the Web layout menu appear unresponsive.
   */
  useLayoutEffect(() => {
    const functionalList = usesFunctionalNoteList(state.viewMode);

    // The phone workspace is list-first: result-set views always need their
    // list, and an ordinary notes view without an active note must never land
    // on the empty editor. The directory remains available from the menu and
    // opening a note still switches explicitly to the editor.
    if ((functionalList || !state.activeNote) && state.mobileView !== "list") {
      actions.setMobileView("list");
    }
  }, [actions, state.activeNote, state.mobileView, state.viewMode]);

  useEffect(() => {
    const clearBlurTimer = () => {
      if (blurTimerRef.current == null) return;
      window.clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const input = getSidebarSearchInput(event.target);
      if (!input || !mobileSidebarOpenRef.current) return;
      if (!shouldCloseDrawerOnSearchEnter(event, input.value)) return;

      event.preventDefault();
      clearBlurTimer();
      input.blur();
      actions.setMobileSidebar(false);
    };

    const handleFocusOut = (event: FocusEvent) => {
      const input = getSidebarSearchInput(event.target);
      if (!input || !mobileSidebarOpenRef.current || !input.value.trim()) return;

      clearBlurTimer();
      blurTimerRef.current = window.setTimeout(() => {
        blurTimerRef.current = null;
        if (!mobileSidebarOpenRef.current) return;

        if (!shouldCloseDrawerAfterSearchBlur(input.value, input, document.activeElement)) return;
        actions.setMobileSidebar(false);
      }, MOBILE_DRAWER_SEARCH_BLUR_DELAY_MS);
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusout", handleFocusOut, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusout", handleFocusOut, true);
      clearBlurTimer();
    };
  }, [actions]);

  useEffect(() => {
    // Android/iOS browsers may begin a native text selection just before dispatching the
    // long-press contextmenu event. NoteList deliberately does not preventDefault touchstart/
    // touchmove because those events also power scrolling, pull-to-refresh and touch sorting.
    // Instead, remember only the card that received the current touch and cancel `selectstart`
    // for that card. Mouse selection on desktop remains untouched.
    let activeTouchCard: HTMLElement | null = null;
    let releaseTimer: number | null = null;

    const clearReleaseTimer = () => {
      if (releaseTimer == null) return;
      window.clearTimeout(releaseTimer);
      releaseTimer = null;
    };

    const handleTouchStart = (event: TouchEvent) => {
      clearReleaseTimer();
      activeTouchCard = getNoteCardSelectionRoot(event.target);
    };

    const handleSelectStart = (event: Event) => {
      if (!shouldSuppressNoteCardSelection(event.target, activeTouchCard)) return;
      event.preventDefault();
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (!shouldSuppressNoteCardSelection(event.target, activeTouchCard)) return;
      // Defensive cleanup for WebViews that created a range before honoring selectstart.
      window.getSelection()?.removeAllRanges();
    };

    const scheduleTouchRelease = () => {
      clearReleaseTimer();
      releaseTimer = window.setTimeout(() => {
        activeTouchCard = null;
        releaseTimer = null;
      }, MOBILE_NOTE_CARD_TOUCH_RELEASE_DELAY_MS);
    };

    document.addEventListener("touchstart", handleTouchStart, true);
    document.addEventListener("selectstart", handleSelectStart, true);
    document.addEventListener("contextmenu", handleContextMenu, true);
    document.addEventListener("touchend", scheduleTouchRelease, true);
    document.addEventListener("touchcancel", scheduleTouchRelease, true);

    return () => {
      document.removeEventListener("touchstart", handleTouchStart, true);
      document.removeEventListener("selectstart", handleSelectStart, true);
      document.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("touchend", scheduleTouchRelease, true);
      document.removeEventListener("touchcancel", scheduleTouchRelease, true);
      clearReleaseTimer();
    };
  }, []);

  useEffect(() => {
    const annotate = () => annotateMobileDrawerControls(document);
    annotate();

    const observer = new MutationObserver(annotate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <style data-mobile-drawer-ux="">{ANDROID_DRAWER_SAFE_AREA_CSS}</style>
      <style data-note-workspace-layout-controls="">{LEGACY_NOTE_LIST_CONTROL_CSS}</style>
      <KnowledgeTreeDrawer />
      <ShortcutHelpCenter />
      <ShortcutRuntimeBridge />
    </>
  );
}
