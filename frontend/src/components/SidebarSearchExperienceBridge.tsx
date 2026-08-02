import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import KnowledgeTreePanel from "@/components/KnowledgeTreePanel";
import KnowledgeTreeSortButton from "@/components/KnowledgeTreeSortButton";
import TaskQuickCaptureBridge from "@/components/tasks/TaskQuickCaptureBridge";
import {
  applySidebarSearchExperience,
  KNOWLEDGE_TREE_FILTER_SELECTOR,
  SIDEBAR_SEARCH_SURFACE_SELECTOR,
} from "@/lib/sidebarSearchExperience";
import {
  loadMobileKnowledgeTreeCompact,
  loadMobileKnowledgeTreeViewMode,
  MOBILE_KNOWLEDGE_TREE_COMPACT_CHANGED_EVENT,
  MOBILE_KNOWLEDGE_TREE_COMPACT_STORAGE_KEY,
  MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT,
  type MobileKnowledgeTreeViewMode,
} from "@/lib/mobileKnowledgeTreeViewMode";

const SORT_SLOT_ATTRIBUTE = "data-knowledge-tree-sort-slot";
const MOBILE_TREE_SLOT_ATTRIBUTE = "data-mobile-knowledge-tree-classic-slot";
const MOBILE_NAVIGATOR_SELECTOR = '[data-sidebar-variant="mobile"] [data-nowen-mobile-knowledge-tree="flat-navigation"]';
let sortSlotSequence = 0;
let mobileModeSurfaceSequence = 0;

interface MobileModeSurface {
  id: string;
  navigatorSurface: HTMLElement;
  treeSlot: HTMLElement;
}

function directChildWithAttribute(parent: HTMLElement, attribute: string): HTMLElement | null {
  return Array.from(parent.children).find(
    (child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute(attribute),
  ) || null;
}

function collectSortSlots(): HTMLElement[] {
  const slots: HTMLElement[] = [];
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(KNOWLEDGE_TREE_FILTER_SELECTOR));

  for (const input of inputs) {
    const filterSurface = input.parentElement;
    const toolbar = filterSurface?.parentElement;
    if (!(filterSurface instanceof HTMLElement) || !(toolbar instanceof HTMLElement)) continue;

    const mobile = Boolean(input.closest<HTMLElement>('[data-knowledge-tree-variant="mobile"]'));
    const treePanel = input.closest<HTMLElement>('[data-nowen-knowledge-tree="embedded"]');
    const compactToolbar = treePanel?.dataset.knowledgeTreeCompactToolbar === "true";
    if (compactToolbar) {
      toolbar.querySelector<HTMLElement>(`[${SORT_SLOT_ATTRIBUTE}]`)?.remove();
      continue;
    }
    let slot = treePanel?.querySelector<HTMLElement>(
      `[${SORT_SLOT_ATTRIBUTE}="mobile-toolbar"]`,
    ) || toolbar.querySelector<HTMLElement>(`[${SORT_SLOT_ATTRIBUTE}]`);
    if (!slot && mobile) continue;
    if (!slot) {
      slot = document.createElement("span");
      slot.setAttribute(SORT_SLOT_ATTRIBUTE, "");
      slot.className = "contents";
      toolbar.insertBefore(slot, filterSurface.nextSibling);
    }
    if (!slot.dataset.knowledgeTreeSortSlotId) {
      slot.dataset.knowledgeTreeSortSlotId = `sort-slot-${++sortSlotSequence}`;
    }
    slots.push(slot);
  }

  return slots;
}

function collectMobileModeSurfaces(): MobileModeSurface[] {
  const result: MobileModeSurface[] = [];
  const navigatorSurfaces = Array.from(document.querySelectorAll<HTMLElement>(MOBILE_NAVIGATOR_SELECTOR));

  for (const navigatorSurface of navigatorSurfaces) {
    const contentHost = navigatorSurface.parentElement;
    if (!(contentHost instanceof HTMLElement)) continue;

    let treeSlot = directChildWithAttribute(contentHost, MOBILE_TREE_SLOT_ATTRIBUTE);
    if (!treeSlot) {
      treeSlot = document.createElement("span");
      treeSlot.setAttribute(MOBILE_TREE_SLOT_ATTRIBUTE, "");
      treeSlot.className = "contents";
      contentHost.appendChild(treeSlot);
    }

    let id = navigatorSurface.dataset.mobileKnowledgeTreeModeSurfaceId;
    if (!id) {
      id = `mobile-tree-mode-${++mobileModeSurfaceSequence}`;
      navigatorSurface.dataset.mobileKnowledgeTreeModeSurfaceId = id;
    }

    result.push({ id, navigatorSurface, treeSlot });
  }

  return result;
}

function sameSlots(current: HTMLElement[], next: HTMLElement[]): boolean {
  return current.length === next.length && current.every((slot, index) => slot === next[index]);
}

function sameMobileModeSurfaces(current: MobileModeSurface[], next: MobileModeSurface[]): boolean {
  return current.length === next.length && current.every((surface, index) => (
    surface.navigatorSurface === next[index]?.navigatorSurface
    && surface.treeSlot === next[index]?.treeSlot
  ));
}

function MobileKnowledgeTreeModeSurface({ surface }: { surface: MobileModeSurface }) {
  const [mode, setMode] = useState<MobileKnowledgeTreeViewMode>(() => loadMobileKnowledgeTreeViewMode());
  const [compact, setCompact] = useState(() => loadMobileKnowledgeTreeCompact());

  useEffect(() => {
    const sync = (event: Event) => {
      const next = (event as CustomEvent<{ mode?: MobileKnowledgeTreeViewMode }>).detail?.mode;
      setMode(next || loadMobileKnowledgeTreeViewMode());
    };
    const syncStorage = (event: StorageEvent) => {
      if (event.key) setMode(loadMobileKnowledgeTreeViewMode());
    };
    window.addEventListener(MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT, sync);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT, sync);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  useEffect(() => {
    const syncCompact = (event: Event) => {
      const next = (event as CustomEvent<{ compact?: boolean }>).detail?.compact;
      setCompact(typeof next === "boolean" ? next : loadMobileKnowledgeTreeCompact());
    };
    const syncStorage = (event: StorageEvent) => {
      if (event.key === MOBILE_KNOWLEDGE_TREE_COMPACT_STORAGE_KEY) {
        setCompact(loadMobileKnowledgeTreeCompact());
      }
    };
    window.addEventListener(MOBILE_KNOWLEDGE_TREE_COMPACT_CHANGED_EVENT, syncCompact);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(MOBILE_KNOWLEDGE_TREE_COMPACT_CHANGED_EVENT, syncCompact);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  useEffect(() => {
    surface.navigatorSurface.style.display = mode === "tree" ? "none" : "";
    return () => {
      surface.navigatorSurface.style.display = "";
    };
  }, [mode, surface.navigatorSurface]);

  return mode === "tree" && createPortal(
    <KnowledgeTreePanel
      variant="mobile"
      className={compact ? "nowen-mobile-tree-density" : undefined}
    />,
    surface.treeSlot,
    `${surface.id}:tree`,
  );
}

function mutationContainsRelevantSurface(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  return (
    node.matches(SIDEBAR_SEARCH_SURFACE_SELECTOR)
    || Boolean(node.querySelector(SIDEBAR_SEARCH_SURFACE_SELECTOR))
    || node.matches(MOBILE_NAVIGATOR_SELECTOR)
    || Boolean(node.querySelector(MOBILE_NAVIGATOR_SELECTOR))
    || node.hasAttribute(SORT_SLOT_ATTRIBUTE)
    || node.hasAttribute(MOBILE_TREE_SLOT_ATTRIBUTE)
    || Boolean(node.querySelector(`[${SORT_SLOT_ATTRIBUTE}], [${MOBILE_TREE_SLOT_ATTRIBUTE}]`))
  );
}

/**
 * 统一内容树上线后的侧栏入口兼容桥。
 *
 * - 退休与树筛选语义冲突的旧全文搜索框；
 * - 在统一树工具栏恢复排序入口；
 * - 应用设置中持久化的移动端目录浏览模式；
 * - 同时兼容桌面与移动 Sidebar 的挂载和工作区切换。
 */
export default function SidebarSearchExperienceBridge() {
  const [sortSlots, setSortSlots] = useState<HTMLElement[]>([]);
  const [mobileModeSurfaces, setMobileModeSurfaces] = useState<MobileModeSurface[]>([]);

  useEffect(() => {
    const applyDocument = () => {
      applySidebarSearchExperience(document);
      const nextSortSlots = collectSortSlots();
      const nextMobileModeSurfaces = collectMobileModeSurfaces();
      setSortSlots((current) => sameSlots(current, nextSortSlots) ? current : nextSortSlots);
      setMobileModeSurfaces((current) => (
        sameMobileModeSurfaces(current, nextMobileModeSurfaces) ? current : nextMobileModeSurfaces
      ));
    };

    applyDocument();

    const observer = new MutationObserver((records) => {
      const relevant = records.some((record) => (
        record.type === "attributes"
        || Array.from(record.addedNodes).some(mutationContainsRelevantSurface)
        || Array.from(record.removedNodes).some(mutationContainsRelevantSurface)
      ));
      if (relevant) applyDocument();
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-knowledge-tree-compact-toolbar"],
      childList: true,
      subtree: true,
    });

    window.addEventListener("nowen:workspace-changed", applyDocument);

    return () => {
      observer.disconnect();
      window.removeEventListener("nowen:workspace-changed", applyDocument);
    };
  }, []);

  return (
    <>
      <TaskQuickCaptureBridge />
      {sortSlots.map((slot) => createPortal(
        <KnowledgeTreeSortButton />,
        slot,
        slot.dataset.knowledgeTreeSortSlotId,
      ))}
      {mobileModeSurfaces.map((surface) => (
        <MobileKnowledgeTreeModeSurface key={surface.id} surface={surface} />
      ))}
    </>
  );
}