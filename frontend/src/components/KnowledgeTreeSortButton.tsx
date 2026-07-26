import { useEffect, useRef, useState } from "react";
import { ArrowUpDown, Check } from "lucide-react";

import {
  KNOWLEDGE_TREE_SORT_CHANGED_EVENT,
  KNOWLEDGE_TREE_SORT_OPTIONS,
  loadKnowledgeTreeSortMode,
  saveKnowledgeTreeSortMode,
  type KnowledgeTreeSortMode,
} from "@/lib/knowledgeTreeSort";
import { cn } from "@/lib/utils";

export default function KnowledgeTreeSortButton() {
  const [mode, setMode] = useState<KnowledgeTreeSortMode>(() => loadKnowledgeTreeSortMode());
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const activeOption = KNOWLEDGE_TREE_SORT_OPTIONS.find((option) => option.value === mode)
    || KNOWLEDGE_TREE_SORT_OPTIONS[0];

  useEffect(() => {
    const sync = (event: Event) => {
      const next = (event as CustomEvent<{ mode?: KnowledgeTreeSortMode }>).detail?.mode;
      setMode(next || loadKnowledgeTreeSortMode());
    };
    window.addEventListener(KNOWLEDGE_TREE_SORT_CHANGED_EVENT, sync);
    return () => window.removeEventListener(KNOWLEDGE_TREE_SORT_CHANGED_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const chooseMode = (nextMode: KnowledgeTreeSortMode) => {
    setMode(nextMode);
    saveKnowledgeTreeSortMode(nextMode);
    setOpen(false);
  };

  return (
    <span ref={rootRef} className="relative flex h-7 w-7 shrink-0 items-center justify-center">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary",
          open && "bg-app-active text-tx-primary",
          mode !== "manual" && "text-accent-primary",
        )}
        title={`排序：${activeOption.label}`}
        aria-label={`内容树排序，当前为${activeOption.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-knowledge-tree-sort-button=""
      >
        <ArrowUpDown size={13} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-8 z-[240] w-36 overflow-hidden rounded-lg border border-app-border bg-app-elevated py-1 shadow-xl"
          data-knowledge-tree-sort-menu=""
        >
          {KNOWLEDGE_TREE_SORT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={mode === option.value}
              onClick={() => chooseMode(option.value)}
              className={cn(
                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
                mode === option.value && "text-accent-primary",
              )}
            >
              <span className="flex h-4 w-4 items-center justify-center">
                {mode === option.value && <Check size={12} />}
              </span>
              <span className="truncate">{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
