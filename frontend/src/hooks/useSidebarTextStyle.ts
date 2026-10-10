import { useCallback, useSyncExternalStore } from "react";

export type SidebarTextStyle = "readable" | "classic";

export const SIDEBAR_TEXT_STYLE_STORAGE_KEY = "nowen.sidebar.textStyle.v1";
const CHANGED_EVENT = "nowen:sidebar-text-style-changed";
let memoryStyle: SidebarTextStyle = "readable";

export function readSidebarTextStyle(): SidebarTextStyle {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_TEXT_STYLE_STORAGE_KEY);
    return stored === "classic" || stored === "readable" ? stored : stored === null ? memoryStyle : "readable";
  } catch {
    return memoryStyle;
  }
}

export function saveSidebarTextStyle(style: SidebarTextStyle): void {
  memoryStyle = style;
  try {
    window.localStorage.setItem(SIDEBAR_TEXT_STYLE_STORAGE_KEY, style);
  } catch {
    // The choice still takes effect in this window when storage is unavailable.
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SIDEBAR_TEXT_STYLE_STORAGE_KEY) {
      memoryStyle = event.newValue === "classic" ? "classic" : "readable";
      onChange();
    }
  };
  window.addEventListener(CHANGED_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useSidebarTextStyle(): readonly [SidebarTextStyle, (style: SidebarTextStyle) => void] {
  const style = useSyncExternalStore(subscribe, readSidebarTextStyle, (): SidebarTextStyle => "readable");
  const setStyle = useCallback((next: SidebarTextStyle) => saveSidebarTextStyle(next), []);
  return [style, setStyle] as const;
}
