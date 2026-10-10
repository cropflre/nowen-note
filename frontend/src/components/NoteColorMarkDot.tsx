import React from "react";
import type { NoteColorMark } from "@/types";
import { cn } from "@/lib/utils";
import { getNoteColorMarkHex } from "@/lib/noteColorMark";

export default function NoteColorMarkDot({
  value,
  className,
  title,
}: {
  value?: NoteColorMark | null;
  className?: string;
  title?: string;
}) {
  const color = getNoteColorMarkHex(value);
  if (!color) return null;
  return (
    <span
      data-note-color-mark={value}
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/15", className)}
      style={{ backgroundColor: color }}
      title={title}
      aria-label={title}
    />
  );
}
