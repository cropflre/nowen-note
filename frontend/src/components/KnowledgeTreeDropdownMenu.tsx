import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

export interface KnowledgeTreeDropdownItem {
  value: string;
  label: string;
  checked?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  sectionLabel?: string;
}

export default function KnowledgeTreeDropdownMenu({
  open,
  anchor,
  items,
  ariaLabel,
  onSelect,
  onClose,
}: {
  open: boolean;
  anchor: HTMLElement | null;
  items: KnowledgeTreeDropdownItem[];
  ariaLabel: string;
  onSelect: (value: string) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [anchor, onClose, open]);

  if (!open || !anchor || typeof document === "undefined") return null;

  const rect = anchor.getBoundingClientRect();
  const width = 184;
  const estimatedHeight = Math.min(320, items.length * 34 + 16);
  const below = rect.bottom + 4;
  const top = below + estimatedHeight <= window.innerHeight - 8
    ? below
    : Math.max(8, rect.top - estimatedHeight - 4);
  const left = Math.min(
    Math.max(8, rect.right - width),
    Math.max(8, window.innerWidth - width - 8),
  );

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      data-knowledge-tree-dropdown={ariaLabel}
      className="fixed z-[320] max-h-[min(320px,calc(100vh-16px))] overflow-y-auto rounded-lg border border-app-border bg-app-elevated p-1 shadow-xl"
      style={{ left, top, width }}
    >
      {items.map((item) => (
        <div key={item.value}>
          {item.separatorBefore && <div className="my-1 border-t border-app-border" />}
          {item.sectionLabel && (
            <div className="px-2 pb-1 pt-1 text-[9px] font-semibold uppercase tracking-wider text-tx-tertiary">
              {item.sectionLabel}
            </div>
          )}
          <button
            type="button"
            role={typeof item.checked === "boolean" ? "menuitemradio" : "menuitem"}
            aria-checked={typeof item.checked === "boolean" ? item.checked : undefined}
            disabled={item.disabled}
            onClick={() => onSelect(item.value)}
            className={cn(
              "flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-tx-secondary hover:bg-app-hover hover:text-tx-primary disabled:cursor-default disabled:opacity-40",
              item.checked && "text-accent-primary",
            )}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {item.checked && <Check size={12} />}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
