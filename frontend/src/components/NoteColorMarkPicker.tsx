import React, { useEffect, useRef, useState } from "react";
import { Palette, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { NoteColorMark } from "@/types";
import { cn } from "@/lib/utils";
import { NOTE_COLOR_MARK_OPTIONS, getNoteColorMarkHex } from "@/lib/noteColorMark";

export default function NoteColorMarkPicker({
  value,
  disabled = false,
  onChange,
}: {
  value?: NoteColorMark | null;
  disabled?: boolean;
  onChange: (value: NoteColorMark | null) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const color = getNoteColorMarkHex(value);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled || saving}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-app-hover disabled:cursor-not-allowed disabled:opacity-40",
          value ? "text-tx-primary" : "text-tx-tertiary",
        )}
        title={t("note.colorMark.action")}
        aria-label={t("note.colorMark.action")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {color ? (
          <span className="h-3.5 w-3.5 rounded-full ring-1 ring-black/10 dark:ring-white/15" style={{ backgroundColor: color }} />
        ) : (
          <Palette size={14} />
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-8 z-[120] w-48 rounded-xl border border-app-border bg-app-elevated p-2 shadow-xl"
          data-note-color-mark-picker=""
        >
          <div className="mb-1 px-1 text-[11px] font-medium text-tx-tertiary">{t("note.colorMark.action")}</div>
          <div className="grid grid-cols-4 gap-1.5">
            {NOTE_COLOR_MARK_OPTIONS.map((option) => {
              const active = (value || null) === option.value;
              return (
                <button
                  key={option.value || "none"}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true);
                    try {
                      await onChange(option.value);
                      setOpen(false);
                    } finally {
                      setSaving(false);
                    }
                  }}
                  className={cn(
                    "flex h-9 items-center justify-center rounded-lg border transition-colors",
                    active ? "border-accent-primary bg-accent-primary/10" : "border-transparent hover:border-app-border hover:bg-app-hover",
                  )}
                  title={t(option.labelKey)}
                  aria-label={t(option.labelKey)}
                >
                  {option.value ? (
                    <span className="h-4 w-4 rounded-full ring-1 ring-black/10 dark:ring-white/15" style={{ backgroundColor: option.hex }} />
                  ) : (
                    <X size={15} className="text-tx-tertiary" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
