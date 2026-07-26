import React, { useEffect, useLayoutEffect, useRef } from "react";
import KnowledgeTreeDrawer from "@/components/KnowledgeTreeDrawer";
import ShortcutHelpCenter from "@/components/ShortcutHelpCenter";
import ShortcutRuntimeBridge from "@/components/ShortcutRuntimeBridge";
import { useApp, useAppActions } from "@/store/AppContext";
import {
  shouldCollapseLegacyNoteList,
  usesFunctionalNoteList,
} from "@/lib/unifiedTreeOnlyLayout";

export const MOBILE_DRAWER_SEARCH_BLUR_DELAY_MS = 160;

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

const ANDROID_DRAWER_SAFE_AREA_CSS = `
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
}
`;

const UNIFIED_TREE_ONLY_CSS = `
/* Legacy notebook-list layout controls are retired. Runtime state is enforced below,
   and these selectors prevent stale large components from exposing a dead control. */
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
  const layoutInitializedRef = useRef(false);
  const previousViewModeRef = useRef(state.viewMode);

  useEffect(() => {
    mobileSidebarOpenRef.current = state.mobileSidebarOpen;
  }, [state.mobileSidebarOpen]);

  /**
   * Unified content tree is the only everyday hierarchy on desktop and mobile.
   * Favorites, tags, Trash and legacy persistent-search results remain dedicated
   * list surfaces because they are cross-tree result sets, not notebook navigation.
   */
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-unified-tree-only", "");

    const collapse = shouldCollapseLegacyNoteList(state.viewMode);
    if (state.noteListCollapsed !== collapse) {
      actions.toggleNoteListCollapsed();
    }

    const functionalList = usesFunctionalNoteList(state.viewMode);
    const viewChanged = previousViewModeRef.current !== state.viewMode;

    if (functionalList) {
      if (viewChanged && state.mobileView !== "list") actions.setMobileView("list");
    } else if (state.mobileView !== "editor") {
      // First boot goes directly to the editor empty state. A later Android back
      // action previously targeting the retired list now opens the unified tree.
      actions.setMobileView("editor");
      if (layoutInitializedRef.current) actions.setMobileSidebar(true);
    }

    previousViewModeRef.current = state.viewMode;
    layoutInitializedRef.current = true;
  }, [actions, state.mobileView, state.noteListCollapsed, state.viewMode]);

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
    const annotate = () => annotateMobileDrawerControls(document);
    annotate();

    const observer = new MutationObserver(annotate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <style data-mobile-drawer-ux="">{ANDROID_DRAWER_SAFE_AREA_CSS}</style>
      <style data-unified-tree-only-layout="">{UNIFIED_TREE_ONLY_CSS}</style>
      <KnowledgeTreeDrawer />
      <ShortcutHelpCenter />
      <ShortcutRuntimeBridge />
    </>
  );
}
