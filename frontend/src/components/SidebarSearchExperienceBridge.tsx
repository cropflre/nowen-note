import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import KnowledgeTreeSortButton from "@/components/KnowledgeTreeSortButton";
import {
  applySidebarSearchExperience,
  KNOWLEDGE_TREE_FILTER_SELECTOR,
  SIDEBAR_SEARCH_SURFACE_SELECTOR,
} from "@/lib/sidebarSearchExperience";

const SORT_SLOT_ATTRIBUTE = "data-knowledge-tree-sort-slot";
let sortSlotSequence = 0;

function collectSortSlots(): HTMLElement[] {
  const slots: HTMLElement[] = [];
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(KNOWLEDGE_TREE_FILTER_SELECTOR));

  for (const input of inputs) {
    const filterSurface = input.parentElement;
    const toolbar = filterSurface?.parentElement;
    if (!(filterSurface instanceof HTMLElement) || !(toolbar instanceof HTMLElement)) continue;

    let slot = Array.from(toolbar.children).find(
      (child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute(SORT_SLOT_ATTRIBUTE),
    );
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

function sameSlots(current: HTMLElement[], next: HTMLElement[]): boolean {
  return current.length === next.length && current.every((slot, index) => slot === next[index]);
}

/**
 * 统一内容树上线后的侧栏入口兼容桥。
 *
 * - 退休与树筛选语义冲突的旧全文搜索框；
 * - 在统一树工具栏恢复排序入口；
 * - 同时兼容桌面与移动 Sidebar 的挂载和工作区切换。
 */
export default function SidebarSearchExperienceBridge() {
  const [sortSlots, setSortSlots] = useState<HTMLElement[]>([]);

  useEffect(() => {
    const applyDocument = () => {
      applySidebarSearchExperience(document);
      const next = collectSortSlots();
      setSortSlots((current) => sameSlots(current, next) ? current : next);
    };

    applyDocument();

    const observer = new MutationObserver((records) => {
      let relevant = false;
      for (const record of records) {
        for (const addedNode of record.addedNodes) {
          if (!(addedNode instanceof Element)) continue;
          if (
            addedNode.matches(SIDEBAR_SEARCH_SURFACE_SELECTOR)
            || addedNode.querySelector(SIDEBAR_SEARCH_SURFACE_SELECTOR)
          ) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;
        for (const removedNode of record.removedNodes) {
          if (!(removedNode instanceof Element)) continue;
          if (
            removedNode.hasAttribute(SORT_SLOT_ATTRIBUTE)
            || removedNode.querySelector(`[${SORT_SLOT_ATTRIBUTE}]`)
          ) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;
      }
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
    </>
  );
}
