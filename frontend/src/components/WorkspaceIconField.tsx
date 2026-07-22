import React, { useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import EmojiPicker from "@/components/EmojiPicker";
import { cn } from "@/lib/utils";

export const DEFAULT_WORKSPACE_ICON = "🏢";

interface WorkspaceIconFieldProps {
  icon: string;
  onChange: (emoji: string) => void;
  label?: string;
  disabled?: boolean;
}

export default function WorkspaceIconField({
  icon,
  onChange,
  label,
  disabled = false,
}: WorkspaceIconFieldProps) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 80, left: 16 });
  const value = icon || DEFAULT_WORKSPACE_ICON;

  const openPicker = () => {
    if (disabled) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    setPosition({
      top: rect ? rect.bottom + 8 : 80,
      left: rect ? rect.left : 16,
    });
    setOpen(true);
  };

  return (
    <div>
      <label className="mb-1 block text-sm">
        {label || t("workspaceManagement.fieldIcon", "图标")}
      </label>
      <button
        ref={buttonRef}
        type="button"
        onClick={openPicker}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("emojiPicker.title", "选择 Emoji 图标")}
        className={cn(
          "flex h-14 min-w-28 items-center gap-3 rounded-lg border border-border bg-background px-3 text-left transition",
          "hover:border-accent-primary/45 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/40",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-2xl leading-none">
          {value}
        </span>
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          {t("emojiPicker.title", "选择 Emoji 图标")}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open && <span data-emoji-picker-open="true" className="hidden" />}
      <AnimatePresence>
        {open && (
          <EmojiPicker
            currentIcon={value}
            position={position}
            onSelect={onChange}
            onClose={() => setOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
