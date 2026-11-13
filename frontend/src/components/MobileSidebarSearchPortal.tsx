import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  loadMobileKnowledgeTreeViewMode,
  MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT,
  MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY,
  type MobileKnowledgeTreeViewMode,
} from "@/lib/mobileKnowledgeTreeViewMode";

export default function MobileSidebarSearchPortal({ children, collapsed, mode }: {
  children: ReactNode;
  collapsed: boolean;
  mode: MobileKnowledgeTreeViewMode;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!collapsed) return;
    // Both browsing panels can remain mounted; only the active mode owns the header search.
    const sync = () => setTarget(loadMobileKnowledgeTreeViewMode() === mode
      ? document.querySelector<HTMLElement>("[data-mobile-sidebar-search-slot]")
      : null);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY) sync();
    };
    sync();
    window.addEventListener(MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, [collapsed, mode]);

  return collapsed && target ? createPortal(children, target) : children;
}
