import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Clock3, TreePine } from "lucide-react";

import KnowledgeTreePanel from "@/components/KnowledgeTreePanel";
import KnowledgeTreeSortButton from "@/components/KnowledgeTreeSortButton";
import {
  applySidebarSearchExperience,
  KNOWLEDGE_TREE_FILTER_SELECTOR,
  SIDEBAR_SEARCH_SURFACE_SELECTOR,
} from "@/lib/sidebarSearchExperience";
import {
  loadMobileKnowledgeTreeViewMode,
  MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT,
  saveMobileKnowledgeTreeViewMode,
  type MobileKnowledgeTreeViewMode,
} from "@/lib/mobileKnowledgeTreeViewMode";
import { cn } from "@/lib/utils";

const SORT_SLOT_ATTRIBUTE = "data-knowledge-tree-sort-slot";
const MOBILE_MODE_SWITCH_SLOT_ATTRIBUTE = "data-mobile-knowledge-tree-mode-switch-slot";
const MOBILE_TREE_SLOT_ATTRIBUTE = "data-mobile-knowledge-tree-classic-slot";
const MOBILE_NAVIGATOR_SELECTOR = '[data-sidebar-variant="mobile"] [data-nowen-mobile-knowledge-tree="flat-navigation"]';
let sortSlotSequence = 0;
let mobileModeSurfaceSequence = 0;

interface MobileModeSurface {
  id: string;
  navigatorSurface: HTMLElement;
  switchSlot: HTMLElement;
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

    let slot = directChildWithAttribute(toolbar, SORT_SLOT_ATTRIBUTE);
    if (!slot) {
      slot = document.createElement("span");
      slot.setAttribute(SORT_SLOT_ATTRIBUTE, "");
      slot.dataset.knowledgeTreeSortSlotId = `sort-slot-${++sortSlotSequence}`;
      slot.className = "contents";
      toolbar.insertBefore(slot, filterSurface.nextSibling);
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
    const section = contentHost?.parentElement;
    const header = contentHost?.previousElementSibling;
    if (!(contentHost instanceof HTMLElement) || !(section instanceof HTMLElement) || !(header instanceof HTMLElement)) continue;

    header.classList.add("flex", "items-center", "justify-between", "gap-2");

    let switchSlot = directChildWithAttribute(header, MOBILE_MODE_SWITCH_SLOT_ATTRIBUTE);
    if (!switchSlot) {
      switchSlot = document.createElement("span");
      switchSlot.setAttribute(MOBILE_MODE_SWITCH_SLOT_ATTRIBUTE, "");
      switchSlot.className = "contents";
      header.appendChild(switchSlot);
    }

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

    result.push({ id, navigatorSurface, switchSlot, treeSlot });
  }

  return result;
}

function sameSlots(current: HTMLElement[], next: HTMLElement[]): boolean {
  return current.length === next.length && current.every((slot, index) => slot === next[index]);
}

function sameMobileModeSurfaces(current: MobileModeSurface[], next: MobileModeSurface[]): boolean {
  return current.length === next.length && current.every((surface, index) => (
    surface.navigatorSurface === next[index]?.navigatorSurface
    && surface.switchSlot === next[index]?.switchSlot
    && surface.treeSlot === next[index]?.treeSlot
  ));
}

function MobileKnowledgeTreeModeSurface({ surface }: { surface: MobileModeSurface }) {
  const [mode, setMode] = useState<MobileKnowledgeTreeViewMode>(() => loadMobileKnowledgeTreeViewMode());

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
    surface.navigatorSurface.style.display = mode === "tree" ? "none" : "";
    return () => {
      surface.navigatorSurface.style.display = "";
    };
  }, [mode, surface.navigatorSurface]);

  const chooseMode = (next: MobileKnowledgeTreeViewMode) => {
    setMode(next);
    saveMobileKnowledgeTreeViewMode(next);
  };

  return (
    <>
      {createPortal(
        <div
          role="group"
          aria-label="目录浏览方式"
          className="flex shrink-0 items-center rounded-lg border border-app-border bg-app-bg p-0.5"
          data-mobile-knowledge-tree-mode-switch=""
        >
          <button
            type="button"
            aria-pressed={mode === "navigator"}
            onClick={() => chooseMode("navigator")}
            className={cn(
              "flex h-6 items-center gap-1 rounded-md px-2 text-[10px] font-medium transition-colors",
              mode === "navigator"
                ? "bg-app-active text-accent-primary shadow-sm"
                : "text-tx-tertiary hover:bg-app-hover hover:text-tx-primary",
            )}
            title="最近与全部：优先展示最近文档，目录逐层进入"
          >
            <Clock3 size={11} />
            <span>最近 / 全部</span>
          </button>
          <button
            type="button"
            aria-pressed={mode === "tree"}
            onClick={() => chooseMode("tree")}
            className={cn(
              "flex h-6 items-center gap-1 rounded-md px-2 text-[10px] font-medium transition-colors",
              mode === "tree"
                ? "bg-app-active text-accent-primary shadow-sm"
                : "text-tx-tertiary hover:bg-app-hover hover:text-tx-primary",
            )}
            title="树形目录：使用原来的可展开目录树"
          >
            <TreePine size={11} />
            <span>树形目录</span>
          </button>
        </div>,
        surface.switchSlot,
        `${surface.id}:switch`,
      )}
      {mode === "tree" && createPortal(
        <KnowledgeTreePanel variant="mobile" />,
        surface.treeSlot,
        `${surface.id}:tree`,
      )}
    </>
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
    || node.hasAttribute(MOBILE_MODE_SWITCH_SLOT_ATTRIBUTE)
    || node.hasAttribute(MOBILE_TREE_SLOT_ATTRIBUTE)
    || Boolean(node.querySelector(`[${SORT_SLOT_ATTRIBUTE}], [${MOBILE_MODE_SWITCH_SLOT_ATTRIBUTE}], [${MOBILE_TREE_SLOT_ATTRIBUTE}]`))
  );
}

/**
 * 统一内容树上线后的侧栏入口兼容桥。
 *
 * - 退休与树筛选语义冲突的旧全文搜索框；
 * - 在统一树工具栏恢复排序入口；
 * - 为移动端提供「最近 / 全部」与原树形目录的持久化切换；
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
        Array.from(record.addedNodes).some(mutationContainsRelevantSurface)
        || Array.from(record.removedNodes).some(mutationContainsRelevantSurface)
      ));
      if (relevant) applyDocument();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener("nowen:workspace-changed", applyDocument);

    return () => {
      observer.disconnect();
      window.removeEventListener("nowen:workspace-changed", applyDocument);
    };
  }, []);

  return (
    <>
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
