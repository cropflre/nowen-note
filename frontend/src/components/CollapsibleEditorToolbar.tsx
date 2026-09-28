import { createContext, useContext, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

export const EDITOR_TOOLBAR_COLLAPSED_KEY = "nowen.editor.toolbarCollapsed.v1";
const CHANGED_EVENT = "nowen:editor-toolbar-collapsed-changed";
let memoryCollapsed = false;

const ToolbarHostContext = createContext<{
  target: HTMLSpanElement | null;
  setTarget: (target: HTMLSpanElement | null) => void;
} | null>(null);

export function EditorToolbarHost({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLSpanElement | null>(null);
  const value = useMemo(() => ({ target, setTarget }), [target]);
  return <ToolbarHostContext.Provider value={value}>{children}</ToolbarHostContext.Provider>;
}

export function EditorToolbarExpandSlot({ location }: { location: "tabs" | "header" }) {
  const host = useContext(ToolbarHostContext);
  if (!host) return null;
  return (
    <span
      ref={host.setTarget}
      data-editor-toolbar-expand-slot={location}
      className="hidden shrink-0 items-center empty:hidden md:flex md:empty:hidden"
    />
  );
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(EDITOR_TOOLBAR_COLLAPSED_KEY) === "true";
  } catch {
    return memoryCollapsed;
  }
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === EDITOR_TOOLBAR_COLLAPSED_KEY || event.key === null) onChange();
  };
  window.addEventListener(CHANGED_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export default function CollapsibleEditorToolbar({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const controlsId = useId();
  const host = useContext(ToolbarHostContext);
  const collapsed = useSyncExternalStore(subscribe, readCollapsed, () => false);
  const label = t(collapsed ? "tiptap.expandToolbar" : "tiptap.collapseToolbar");

  const toggle = () => {
    memoryCollapsed = !collapsed;
    try {
      window.localStorage.setItem(EDITOR_TOOLBAR_COLLAPSED_KEY, String(memoryCollapsed));
    } catch {
      // Keep the choice usable when this browser cannot persist preferences.
    }
    window.dispatchEvent(new Event(CHANGED_EVENT));
  };

  const toggleButton = (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls={controlsId}
      title={label}
      className={cn(
        "hidden h-6 w-6 items-center justify-center rounded-md text-tx-secondary hover:bg-app-hover hover:text-tx-primary md:flex",
        (!collapsed || !host?.target) && "absolute right-1 top-1 z-40 bg-app-surface/95",
      )}
    >
      {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
    </button>
  );

  return (
    <div
      data-editor-toolbar-collapsed={collapsed ? "true" : "false"}
      className={cn("relative shrink-0 md:sticky md:top-0 md:z-20", collapsed && "md:h-0")}
    >
      {collapsed && host?.target ? createPortal(toggleButton, host.target) : toggleButton}
      <div id={controlsId} className={collapsed ? "md:hidden" : undefined}>
        {children}
      </div>
    </div>
  );
}
