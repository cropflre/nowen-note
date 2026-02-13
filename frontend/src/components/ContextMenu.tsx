import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  isOpen: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  menuRef: React.RefObject<HTMLDivElement | null>;
  onAction: (actionId: string) => void;
  header?: string;
}

export default function ContextMenu({
  isOpen, x, y, items, menuRef, onAction, header,
}: ContextMenuProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={menuRef}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.12, ease: "easeOut" }}
          style={{ position: "fixed", top: y, left: x, zIndex: 100 }}
          className="w-48 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-xl dark:shadow-2xl dark:shadow-black/50 py-1 select-none"
        >
          {header && (
            <div className="px-3 py-1.5 text-[11px] font-medium text-tx-tertiary border-b border-zinc-100 dark:border-zinc-800 mb-0.5 truncate">
              {header}
            </div>
          )}
          {items.map((item) =>
            item.separator ? (
              <div key={item.id} className="h-px bg-zinc-200 dark:bg-zinc-800 my-1 mx-2" />
            ) : (
              <button
                key={item.id}
                disabled={item.disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!item.disabled) onAction(item.id);
                }}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors",
                  item.disabled && "opacity-40 cursor-not-allowed",
                  item.danger
                    ? "text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                    : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-tx-primary"
                )}
              >
                {item.icon && <span className="w-4 h-4 flex items-center justify-center">{item.icon}</span>}
                {item.label}
              </button>
            )
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
