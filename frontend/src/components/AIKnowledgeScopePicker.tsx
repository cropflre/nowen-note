import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Database, Folder, Search, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Notebook } from "@/types";

interface AIKnowledgeScopePickerProps {
  notebooks: Pick<Notebook, "id" | "name">[];
  value: string;
  onChange: (notebookId: string) => void;
  allLabel: string;
}

export default function AIKnowledgeScopePicker({
  notebooks,
  value,
  onChange,
  allLabel,
}: AIKnowledgeScopePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedNotebook = notebooks.find((notebook) => notebook.id === value);
  const selectedLabel = selectedNotebook?.name || allLabel;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredNotebooks = useMemo(() => (
    normalizedQuery
      ? notebooks.filter((notebook) => notebook.name.toLocaleLowerCase().includes(normalizedQuery))
      : notebooks
  ), [normalizedQuery, notebooks]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    window.requestAnimationFrame(() => searchRef.current?.focus());
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const closeOnResize = () => setOpen(false);
    window.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnResize);
    return () => {
      window.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [open]);

  const handleSelect = (notebookId: string) => {
    onChange(notebookId);
    setOpen(false);
  };

  let menu: ReactNode = null;
  if (open && buttonRef.current && typeof document !== "undefined") {
    const rect = buttonRef.current.getBoundingClientRect();
    const width = Math.min(320, Math.max(272, rect.width + 72));
    const estimatedHeight = Math.min(360, 112 + notebooks.length * 36);
    const top = rect.top - estimatedHeight - 8 >= 8
      ? rect.top - estimatedHeight - 8
      : Math.min(window.innerHeight - estimatedHeight - 8, rect.bottom + 8);
    const left = Math.min(
      Math.max(8, rect.left),
      Math.max(8, window.innerWidth - width - 8),
    );

    menu = createPortal(
      <div
        ref={menuRef}
        role="dialog"
        aria-label="知识库范围"
        className="fixed z-[350] overflow-hidden rounded-2xl border border-app-border bg-app-elevated shadow-2xl shadow-black/15"
        style={{ left, top: Math.max(8, top), width }}
      >
        <div className="border-b border-app-border p-2.5">
          <div className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-tx-tertiary">选择知识库范围</div>
          <div className="flex items-center gap-2 rounded-xl border border-app-border bg-app-bg px-2.5 py-2 text-tx-tertiary focus-within:border-accent-primary/50 focus-within:ring-2 focus-within:ring-accent-primary/10">
            <Search size={13} className="shrink-0" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索笔记本"
              aria-label="搜索笔记本"
              className="min-w-0 flex-1 bg-transparent text-xs text-tx-primary outline-none placeholder:text-tx-tertiary"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                title="清空搜索"
                className="rounded-md p-0.5 hover:bg-app-hover hover:text-tx-primary"
              >
                <X size={11} />
              </button>
            )}
          </div>
        </div>

        <div className="max-h-64 overflow-y-auto p-1.5">
          {!normalizedQuery && (
            <button
              type="button"
              aria-pressed={!value}
              onClick={() => handleSelect("")}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                !value ? "bg-accent-primary/10 text-accent-primary" : "text-tx-secondary hover:bg-app-hover",
              )}
            >
              <span className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                !value ? "bg-accent-primary text-white" : "bg-app-hover text-tx-tertiary",
              )}>
                <Database size={13} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{allLabel}</span>
                <span className="mt-0.5 block text-[10px] text-tx-tertiary">检索当前空间内的全部笔记</span>
              </span>
              {!value && <Check size={14} className="shrink-0" />}
            </button>
          )}

          {filteredNotebooks.map((notebook) => {
            const selected = value === notebook.id;
            return (
              <button
                key={notebook.id}
                type="button"
                aria-pressed={selected}
                onClick={() => handleSelect(notebook.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                  selected ? "bg-accent-primary/10 text-accent-primary" : "text-tx-secondary hover:bg-app-hover",
                )}
              >
                <span className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg",
                  selected ? "bg-accent-primary/15 text-accent-primary" : "bg-app-hover text-tx-tertiary",
                )}>
                  <Folder size={13} />
                </span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{notebook.name}</span>
                {selected && <Check size={14} className="shrink-0" />}
              </button>
            );
          })}

          {!filteredNotebooks.length && (
            <div className="px-3 py-8 text-center">
              <Search size={18} className="mx-auto mb-2 text-tx-tertiary/60" />
              <p className="text-[11px] text-tx-tertiary">没有匹配的笔记本</p>
            </div>
          )}
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          "flex h-7 min-w-28 max-w-56 items-center gap-1.5 rounded-lg px-2 text-left text-[11px] font-medium transition-colors",
          open
            ? "bg-accent-primary/10 text-accent-primary ring-1 ring-accent-primary/30"
            : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
        )}
      >
        {value ? <Folder size={12} className="shrink-0" /> : <Database size={12} className="shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{selectedLabel}</span>
        <ChevronDown size={11} className={cn("shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {menu}
    </>
  );
}
