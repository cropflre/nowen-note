import { useEffect } from "react";

/**
 * The legacy TaskCenter renders search and quick-add as adjacent full-width rows. They are
 * functionally different but visually almost identical, which makes accidental clicks likely.
 * Keep TaskCenter's data/state logic untouched and annotate only these two existing surfaces so
 * the hierarchy can be corrected without coupling search state to the quick-add component.
 */
export const TASK_ENTRY_HIERARCHY_CSS = `
[data-task-search-section] {
  width: min(360px, calc(100% - 40px));
  align-self: flex-end;
  margin: 10px 20px 0;
  padding: 7px 10px !important;
  border: 1px solid var(--color-border, #e5e7eb) !important;
  border-radius: 10px;
  background: var(--color-surface, #ffffff);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
  transition: border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease;
}

[data-task-search-section]:focus-within {
  border-color: var(--color-accent-primary, #3b82f6) !important;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.10);
}

[data-task-search-section] input {
  min-width: 0;
  font-size: 12px;
}

[data-task-search-section] svg {
  opacity: 0.78;
}

[data-task-create-section] {
  margin: 10px 20px 12px;
  padding: 0 !important;
  border-bottom: 0 !important;
}

@media (max-width: 767px) {
  [data-task-search-section] {
    width: auto;
    align-self: stretch;
    margin: 8px 12px 0;
  }

  [data-task-create-section] {
    margin: 8px 12px 10px;
  }
}
`;

export function annotateTaskEntrySurfaces(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-task-quick-add]").forEach((quickAdd) => {
    const createSection = quickAdd.parentElement;
    if (!(createSection instanceof HTMLElement)) return;
    createSection.setAttribute("data-task-create-section", "");

    const searchSection = createSection.previousElementSibling;
    if (!(searchSection instanceof HTMLElement)) return;
    const searchInput = searchSection.querySelector<HTMLInputElement>('input[type="text"]');
    const searchIcon = searchSection.querySelector("svg.lucide-search");
    if (!searchInput || !searchIcon) return;

    searchSection.setAttribute("data-task-search-section", "");
    const chinese = document.documentElement.lang.toLowerCase().startsWith("zh");
    const label = chinese ? "搜索任务" : "Search tasks";
    searchInput.setAttribute("aria-label", label);
    searchInput.setAttribute("title", label);
  });
}

export default function TaskEntryUxBridge() {
  useEffect(() => {
    const apply = () => annotateTaskEntrySurfaces(document);
    apply();

    const observer = new MutationObserver((records) => {
      if (!records.some((record) => record.addedNodes.length > 0 || record.removedNodes.length > 0)) return;
      apply();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return <style data-task-entry-ux="">{TASK_ENTRY_HIERARCHY_CSS}</style>;
}
